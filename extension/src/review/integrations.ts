import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RunJournal } from '../run/journal';
import type { Run } from '../types';
import { normalizeReviewPath } from './matching';

const sources = ['Jenkins', 'GitHub PR', 'GitHub checks', 'BuildKit provenance', 'BuildKit file'] as const;
const maxBytes = 8 * 1024 * 1024;

class ProviderResponseError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? 'Provider credentials were rejected.'
      : status === 403 ? 'The provider refused access to this resource.'
      : status === 429 ? 'The provider rate limit is active. Retry after its reset window.'
      : 'Provider returned HTTP ' + status);
  }
}

async function download(url: URL, headers: Record<string, string>, attempts = 2) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if (attempts > 1 && [429, 502, 503, 504].includes(response.status)) {
      const header = response.headers.get('retry-after');
      const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 300;
      if (Number.isFinite(delay) && delay <= 2000) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)));
        return download(url, headers, attempts - 1);
      }
    }
    throw new ProviderResponseError(response.status);
  }
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

async function pages<T>(url: URL, headers: Record<string, string>, parse: (raw: unknown) => T[]): Promise<T[]> {
  const items: T[] = [];
  let target: URL | undefined = url;
  for (let count = 0; target; count++) {
    if (count >= 20) throw new Error('The resource has more pages than one import can handle.');
    if (target.origin !== url.origin || target.pathname !== url.pathname || target.username || target.password) {
      throw new Error('Unexpected pagination destination.');
    }
    const { body, next } = await download(target, headers);
    items.push(...parse(JSON.parse(body.toString('utf8'))));
    target = next ? new URL(next, url) : undefined;
  }
  return items;
}

const githubChecks = z.object({
  check_runs: z.array(z.object({
    id: z.number().int().positive(), name: z.string(), status: z.string(),
    conclusion: z.string().nullable(), head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
    html_url: z.string().nullable().optional(),
    output: z.object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() }).optional(),
  })),
});

const jenkins = z.object({
  number: z.number(), result: z.string().nullable(), building: z.boolean(), url: z.string().optional(),
  actions: z.array(z.object({ lastBuiltRevision: z.object({ SHA1: z.string() }).optional() })).optional(),
});

const testReport = z.object({
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  skipCount: z.number().int().nonnegative(),
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
    if (source === 'BuildKit file') {
      const [file] = await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'BuildKit statements': ['json'] },
      }) ?? [];
      if (!file) return;
      const stat = await vscode.workspace.fs.stat(file);
      if (stat.size > maxBytes) throw new Error('Attestation exceeds 8 MiB.');
      const bytes = await vscode.workspace.fs.readFile(file);
      if (bytes.length > maxBytes) throw new Error('Attestation exceeds 8 MiB.');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const statement = attestation.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      for (const subject of statement.subject) {
        journal.record(run.id, {
          kind: 'check', source: 'BuildKit provenance', name: subject.name, status: 'local statement imported',
          detail: statement.predicateType, externalId: 'sha256:' + digest + ':' + subject.digest.sha256,
        });
      }
      await journal.flush();
      void vscode.window.showInformationMessage('Imported the BuildKit statement and calculated its digest.');
      return;
    }
    const input = await vscode.window.showInputBox({
      prompt: source === 'Jenkins' ? 'Build URL including its build number'
        : source === 'GitHub PR' ? 'GitHub pull request URL'
          : source === 'GitHub checks' ? 'GitHub commit URL with the full SHA' : 'HTTPS URL of a BuildKit provenance statement',
    });
    if (!input) return;
    let url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTPS resource URL without credentials, query parameters, or a fragment.');
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    let expectedDigest: string | undefined;
    let expectedCommit: string | undefined;
    if (source === 'GitHub PR') {
      const parts = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.hostname !== 'github.com' || !parts) throw new Error('Use a github.com pull request URL.');
      url = new URL('https://api.github.com/repos/' + parts[1] + '/' + parts[2] + '/pulls/' + parts[3] + '/comments?per_page=100');
      headers.Accept = 'application/vnd.github+json';
    } else if (source === 'GitHub checks') {
      const parts = /^\/([\w.-]+)\/([\w.-]+)\/commit\/([a-f0-9]{40})\/?$/i.exec(url.pathname);
      if (url.hostname !== 'github.com' || !parts) throw new Error('Use a github.com commit URL with the full SHA.');
      expectedCommit = parts[3].toLowerCase();
      url = new URL('https://api.github.com/repos/' + parts[1] + '/' + parts[2] + '/commits/' + expectedCommit + '/check-runs?per_page=100');
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

    if (source === 'GitHub checks') {
      const checks = await pages(url, headers, raw => githubChecks.parse(raw).check_runs);
      if (checks.some(check => check.head_sha.toLowerCase() !== expectedCommit)) {
        throw new Error('GitHub returned a check associated with a different revision.');
      }
      for (const check of checks) {
        journal.record(run.id, { kind: 'check', source, name: check.name, status: check.conclusion ?? check.status,
          revision: check.head_sha, detail: (check.output?.summary ?? check.output?.title)?.slice(0, 2000),
          externalId: url.pathname + ':' + check.id, sourceUrl: check.html_url ?? undefined });
      }
    } else if (source === 'Jenkins') {
      const { body } = await download(url, headers);
      const build = jenkins.parse(JSON.parse(body.toString('utf8')));
      const revisions = [...new Set(build.actions?.flatMap(action => action.lastBuiltRevision?.SHA1 ?? []) ?? [])];
      const testUrl = new URL(url);
      testUrl.pathname = testUrl.pathname.replace(/\/api\/json$/, '/testReport/api/json');
      testUrl.searchParams.set('tree', 'passCount,failCount,skipCount');
      let detail: string | undefined;
      if (!build.building) {
        try {
          const test = await download(testUrl, headers);
          const counts = testReport.parse(JSON.parse(test.body.toString('utf8')));
          detail = `${counts.passCount} passed, ${counts.failCount} failed, ${counts.skipCount} skipped`;
        } catch (error) {
          detail = error instanceof ProviderResponseError && error.status === 404
            ? 'No test report published' : 'Test report unavailable';
        }
      }
      journal.record(run.id, { kind: 'check', source, name: 'Build #' + build.number, status: build.building ? 'running' : build.result ?? 'unknown',
        revision: revisions.length === 1 ? revisions[0] : undefined, externalId: url.origin + url.pathname, detail });
    } else if (source === 'GitHub PR') {
      const items = await pages(url, headers, raw => comments.parse(raw));
      for (const item of items) {
        journal.record(run.id, { kind: 'check', source, name: item.user?.login ?? 'Review comment', status: 'comment',
          detail: item.body, location: normalizeReviewPath(item.path), revision: item.commit_id,
          baseRevision: item.original_commit_id, startLine: item.start_line ?? item.line ?? undefined,
          endLine: item.line ?? undefined, side: item.side === 'LEFT' ? 'base' : item.side === 'RIGHT' ? 'candidate' : undefined,
          externalId: 'github:' + item.id, sourceUrl: item.html_url });
      }
    } else {
      const { body } = await download(url, headers);
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== expectedDigest) throw new Error('The provenance artifact does not match the expected digest.');
      const statement = attestation.parse(JSON.parse(body.toString('utf8')));
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
