import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analyzeReview } from '../localReview/model';
import { readGitHistory } from '../localReview/gitHistory';
import { importReplay, readReplay } from '../replay/records';
import type { RunJournal } from '../run/journal';
import type { RunManager } from '../run/runManager';
import type { UiStreamEvent, RunStateMsg } from '../types';
import type { ReviewEngine } from './diffView';

const messageSchema = z.object({ id: z.number().int(), path: z.string(), body: z.unknown().optional() });
const selection = z.object({ key: z.string(), id: z.string(), decision: z.enum(['accepted', 'rejected']) });
const link = z.object({ key: z.string(), text: z.string().trim().min(1).max(2000), hunkIds: z.array(z.string()).min(1) });

export function registerWorkbench(ctx: vscode.ExtensionContext, review: ReviewEngine, journal: RunJournal | undefined, runs: RunManager, endpoint: string) {
  let current: vscode.WebviewPanel | undefined;
  let summary = '', activity = '', lastId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = () => ({ state: runs.active?.state ?? 'idle', agent: runs.active?.agent, endpoint,
    request: runs.active?.request, sessionId: runs.active?.sessionId, summary, activity });
  const notify = () => {
    if (current && !timer) timer = setTimeout(() => {
      timer = undefined;
      void current?.webview.postMessage({ type: 'run', run: snapshot() });
    }, 60);
  };
  const state = (s: RunStateMsg) => {
    if (lastId !== runs.active?.id) { lastId = runs.active?.id; summary = ''; activity = ''; }
    if (s.banner) activity = s.banner;
    notify();
    if (s.state === 'awaiting-review') void vscode.commands.executeCommand('contexo.openWorkbench');
  };
  const stream = (events: UiStreamEvent[]) => {
    for (const event of events) {
      if (event.kind === 'text-delta') summary = (summary + event.text).slice(-24000);
      if (event.kind === 'tool-call') activity = event.name;
      if (event.kind === 'turn-done' && event.error) activity = event.error;
    }
    notify();
  };
  runs.on('state', state);
  runs.on('stream', stream);
  ctx.subscriptions.push({ dispose() { clearTimeout(timer); runs.off('state', state); runs.off('stream', stream); current?.dispose(); } });
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.openWorkbench', async () => {
    if (current) { current.reveal(); await current.webview.postMessage({ type: 'refresh' }); return; }
    const assets = vscode.Uri.joinPath(ctx.extensionUri, 'local-review');
    const panel = vscode.window.createWebviewPanel('contexo.workbench', 'Contexo Review', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [assets] });
    current = panel;
    const view = panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const html = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(assets, 'index.html')));
    async function dispatch(path: string, body: unknown) {
      if (path === '/api/run') return snapshot();
      if (path === '/api/ask') {
        const prompt = z.string().trim().min(1).max(32000).parse(body);
        if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a repository folder first.');
        if (['streaming','awaiting-review'].includes(runs.active?.state ?? '')) throw new Error('Finish or stop the current run first.');
        void runs.start('agent', prompt).catch(error => { activity = String(error); notify(); });
        return snapshot();
      }
      if (path === '/api/stop') { await runs.stop(); return snapshot(); }
      if (path === '/api/setup') { await vscode.commands.executeCommand('contexo.openSetup'); return true; }
      if (path === '/api/commits') {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) throw new Error('Open a Git workspace first.');
        return readGitHistory(root.uri.fsPath);
      }
      if (path === '/api/replay') {
        const input = z.object({ format: z.enum(['native','acp','otlp']), text: z.string().max(4 << 20) }).parse(body);
        return readReplay(importReplay(input.text, input.format).content);
      }
      if (path === '/api/current-replay') {
        const runId = runs.active?.id;
        if (!journal || !runId) throw new Error('No current run. Open a saved run record below.');
        return readReplay(await journal.read(runId));
      }
      const p = review.pending;
      if (!p) throw new Error('No pending proposal. Start an assistant edit, then refresh this review.');
      if (path === '/api/decision') {
        const a = selection.parse(body);
        if (p.key !== a.key || !p.hunks.some(h => h.id === a.id)) throw new Error('The proposal changed.');
        await review.setDecision(a.id, a.decision);
      } else if (path === '/api/apply') {
        if (body !== p.key || !p.hunks.some(h => h.decision === 'accepted')) throw new Error('Refresh and select hunks first.');
        await review.applyAccepted(p.key);
        return { status: p.status };
      } else if (path === '/api/requirement') {
        const a = link.parse(body);
        if (!journal || p.key !== a.key || !a.hunkIds.every(id => p.hunks.some(h => h.id === id))) throw new Error('Refresh the proposal before linking.');
        journal.record(p.runId, { kind: 'requirement-link', requirementId: randomUUID(), requirementText: a.text,
          proposalKey: p.key, hunkIds: a.hunkIds, checkSequences: [], source: 'manual' });
      } else if (path !== '/api/review') throw new Error('Unknown review operation.');
      const records = journal ? readReplay(await journal.read(p.runId).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return '';
        throw e;
      })).records : [];
      const checks = records.map(r => r.evidence).filter(e => e.kind === 'check').map(e => ({
        name: String(e.name), source: String(e.source), status: String(e.status), candidateDigest: e.candidateDigest,
      }));
      const requirements = records.map(r => r.evidence).filter(e => e.kind === 'requirement-link' && e.proposalKey === p.key)
        .map(e => ({ text: e.requirementText, hunkIds: e.hunkIds }));
      const result = await analyzeReview({ files: p.files, checks, requirements, rejected: p.hunks.filter(h => h.decision !== 'accepted').map(h => h.id) });
      return { ...result, summary: p.summary, proposalKey: p.key, hunks: p.hunks };
    }
    const listener = view.onDidReceiveMessage(async value => {
      const parsed = messageSchema.safeParse(value);
      if (!parsed.success) return;
      const { id, path, body } = parsed.data;
      try { await view.postMessage({ id, result: await dispatch(path, body) }); }
      catch (error) { await view.postMessage({ id, error: error instanceof Error ? error.message : 'Review operation failed' }); }
    });
    panel.onDidDispose(() => { current = undefined; listener.dispose(); });
    view.html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + view.cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">')
      .replace('href="/app.css"', 'href="' + view.asWebviewUri(vscode.Uri.joinPath(assets, 'app.css')) + '"')
      .replace('src="/glow.js"', 'nonce="' + nonce + '" src="' + view.asWebviewUri(vscode.Uri.joinPath(assets, 'glow.js')) + '"')
      .replace('src="/app.js"', 'nonce="' + nonce + '" src="' + view.asWebviewUri(vscode.Uri.joinPath(assets, 'app.js')) + '"');
  }));
}
