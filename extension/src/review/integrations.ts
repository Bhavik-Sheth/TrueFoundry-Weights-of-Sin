import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunJournal } from '../run/journal';
import type { Run } from '../types';
import { normalizeReviewPath } from './matching';

const sources = ['Jenkins', 'GitHub PR', 'BuildKit provenance'] as const;
const maxBytes = 8 * 1024 * 1024;

async function download(url: URL, headers: Record<string, string>) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error('Provider returned HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Provider response exceeds 8 MiB.');
      chunks.push(value);
    }
    return { body: Buffer.concat(chunks), next: response.headers.get('link')?.split(',').find(link => link.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1] };
  } finally {
    await reader.cancel();
  }
}

const jenkins = z.object({
  number: z.number(), result: z.string().nullable(), building: z.boolean(), url: z.string().optional(),
  actions: z.array(z.object({ lastBuiltRevision: z.object({ SHA1: z.string() }).optional() })).optional(),
});

const comments = z.array(z.object({
  id: z.number(), body: z.string(), path: z.string(), commit_id: z.string().optional(),
  original_commit_id: z.string().optional(), line: z.number().nullable().optional(),
  start_line: z.number().nullable().optional(), side: z.enum(['LEFT', 'RIGHT']).optional(),
  html_url: z.string().optional(), user: z.object({ login: z.string() }).nullable(),
}));

const attestation = z.object({
  predicateType: z.string(),
  subject: z.array(z.object({ name: z.string(), digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) }) })).min(1),
});

export function registerIntegrations(context: vscode.ExtensionContext, journal: RunJournal, active: () => Run | undefined) {
  context.subscriptions.push(vscode.commands.registerCommand('contexo.syncReviewEvidence', async () => {
    const run = active();
    if (!run) throw new Error('Open a run before importing evidence.');
    const source = await vscode.window.showQuickPick(sources, { placeHolder: 'Choose an external evidence source' });
    if (!source) return;
    const input = await vscode.window.showInputBox({
      prompt: source === 'Jenkins' ? 'Build URL including its build number'
        : source === 'GitHub PR' ? 'GitHub pull request URL' : 'HTTPS URL of a BuildKit provenance statement',
    });
    if (!input) return;
    let url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTPS resource URL without credentials, query parameters, or a fragment.');
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    let expectedDigest: string | undefined;
    if (source === 'GitHub PR') {
      const parts = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.hostname !== 'github.com' || !parts) throw new Error('Use a github.com pull request URL.');
      url = new URL('https://api.github.com/repos/' + parts[1] + '/' + parts[2] + '/pulls/' + parts[3] + '/comments?per_page=100');
      headers.Accept = 'application/vnd.github+json';
    } else if (source === 'Jenkins') {
      if (!/\/\d+\/?$/.test(url.pathname)) throw new Error('Use the URL of a specific Jenkins build.');
      url.pathname = url.pathname.replace(/\/$/, '') + '/api/json';
      url.searchParams.set('tree', 'number,result,building,url,actions[lastBuiltRevision[SHA1]]');
    } else {
      const digest = await vscode.window.showInputBox({ prompt: 'Expected SHA-256 of the provenance artifact' });
      if (digest === undefined) return;
      expectedDigest = digest.replace(/^sha256:/, '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Enter a 64-character SHA-256 digest.');
    }
    const secretKey = 'contexo.review:' + source + ':' + url.origin;
    const saved = await context.secrets.get(secretKey);
    const token = await vscode.window.showInputBox({
      password: true,
      prompt: source === 'Jenkins' ? 'Username:API-token' : 'API token',
      placeHolder: saved ? 'Leave blank to reuse saved credentials' : 'Leave blank for a public resource',
    });
    if (token === undefined) return;
    const credential = token || saved;
    if (credential) {
      headers.Authorization = source === 'Jenkins' ? 'Basic ' + Buffer.from(credential).toString('base64') : 'Bearer ' + credential;
    }

    const result = await download(url, headers);
    const raw: unknown = JSON.parse(result.body.toString('utf8'));
    if (source === 'Jenkins') {
      const build = jenkins.parse(raw);
      const revisions = [...new Set(build.actions?.flatMap(action => action.lastBuiltRevision?.SHA1 ?? []) ?? [])];
      journal.record(run.id, { kind: 'check', source, name: 'Build #' + build.number, status: build.building ? 'running' : build.result ?? 'unknown',
        revision: revisions.length === 1 ? revisions[0] : undefined, externalId: url.origin + url.pathname });
    } else if (source === 'GitHub PR') {
      const items = comments.parse(raw);
      let next = result.next;
      for (let page = 1; next; page++) {
        if (page >= 20) throw new Error('The pull request has more comments than one import can handle.');
        const target = new URL(next);
        if (target.origin !== url.origin || target.pathname !== url.pathname) throw new Error('Unexpected pagination destination.');
        const fetched = await download(target, headers);
        items.push(...comments.parse(JSON.parse(fetched.body.toString('utf8'))));
        next = fetched.next;
      }
      for (const item of items) {
        journal.record(run.id, { kind: 'check', source, name: item.user?.login ?? 'Review comment', status: 'comment',
          detail: item.body, location: normalizeReviewPath(item.path), revision: item.commit_id,
          baseRevision: item.original_commit_id, startLine: item.start_line ?? item.line ?? undefined,
          endLine: item.line ?? undefined, side: item.side === 'LEFT' ? 'base' : item.side === 'RIGHT' ? 'candidate' : undefined,
          externalId: 'github:' + item.id, sourceUrl: item.html_url });
      }
    } else {
      const actual = createHash('sha256').update(result.body).digest('hex');
      if (actual !== expectedDigest) throw new Error('The provenance artifact does not match the expected digest.');
      const statement = attestation.parse(raw);
      for (const subject of statement.subject) {
        journal.record(run.id, { kind: 'check', source, name: subject.name, status: 'artifact digest matched',
          detail: statement.predicateType, externalId: 'sha256:' + actual + ':' + subject.digest.sha256 });
      }
    }
    await journal.flush();
    if (token) await context.secrets.store(secretKey, token);
    void vscode.window.showInformationMessage('Attached ' + source + ' evidence to the run record.');
  }));
}
