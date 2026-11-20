/**
 * extension.ts - extension entry point (C1 Editor Shell & Panel; wires all components).
 *
 * Exports:
 *  - activate(ctx): wiring in the order fixed by docs/S0_CONTRACT.md: config, panel, status bar,
 *    indexer, review engine, TrueForge client, RunManager, MCP server (fixed port + stored token),
 *    inline edit, dev commands, event plumbing, panel messages, and the commands contexo.stop,
 *    contexo.copyMcpConnection, contexo.reindex.
 *  - deactivate(): stop the MCP server and cancel the active run.
 *
 * Rules: activation must not block the host (indexing is async inside startIndexing()).
 * Depends on: config, log, types, shell/*, run/*, mcp/*, context/*, review/*, dev/*.
 * Depended on by: VS Code (package.json "main" via dist/extension.js).
 */
import * as vscode from 'vscode';
import { getConfig } from './config';
import { log } from './log';
import type { ToWebview } from './types';
import { ContexoPanelProvider } from './shell/panel';
import { StatusBar } from './shell/statusBar';
import { startIndexing } from './context/indexer';
import { registerReview } from './review/diffView';
import { createSessionInspector, createTfClient } from './run/tfClient';
import { RunManager } from './run/runManager';
import { getOrCreateToken, startServer } from './mcp/server';
import type { McpHandle } from './mcp/server';
import { makeToolRegistrar } from './mcp/tools';
import { registerInlineEdit } from './shell/inlineEdit';
import { registerDevCommands } from './dev/devCommands';
import { SetupController } from './shell/setupController';
import { SessionController } from './shell/sessionController';

import { RunJournal } from './run/journal';
import { readdir } from 'node:fs/promises';

let journalRef: RunJournal | undefined;
let mcpHandle: McpHandle | undefined;
let runsRef: RunManager | undefined;
let setupRef: SetupController | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = getConfig();
  const panel = new ContexoPanelProvider(ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(ContexoPanelProvider.viewId, panel));
  const post = (m: ToWebview) => panel.post(m);
  const status = new StatusBar();
  ctx.subscriptions.push(status);
  const index = startIndexing();
  const review = registerReview(ctx, post);
  review.index = index;
  const tf = createTfClient(cfg);
  const journalDirectory = ctx.storageUri && vscode.Uri.joinPath(ctx.storageUri, 'runs').fsPath;
  const journal = journalDirectory
    ? new RunJournal(journalDirectory, error => console.error('Contexo run recording failed', error))
    : undefined;
  journalRef = journal;
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.openRunRecord', async () => {
    await journal?.flush();
    const files = journalDirectory
      ? await readdir(journalDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })
      : [];
    const ids = files.filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -6));
    if (!journal || !ids.length) {
      await vscode.window.showInformationMessage('No recorded runs in this workspace yet.');
      return;
    }
    const id = await vscode.window.showQuickPick(ids, { placeHolder: 'Open a recorded run' });
    if (id) {
      const content = await journal.read(id);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'jsonl' }));
    }
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.importSecurityReport', async () => {
    const run = runs.active;
    if (!journal || !run) {
      await vscode.window.showInformationMessage('Start a workspace run before attaching a report.');
      return;
    }
    const selection = await vscode.window.showOpenDialog({ filters: { SARIF: ['sarif', 'json'] }, canSelectMany: false });
    if (!selection?.length) return;
    const report = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(selection[0])).toString('utf8'));
    if (report.version !== '2.1.0' || !Array.isArray(report.runs)) {
      throw new Error('Expected a SARIF 2.1.0 report.');
    }
    const findings = report.runs.flatMap((scan: { tool: { driver: { name: string } }; results?: Array<{
      ruleId?: string; level?: string; message: { text?: string }; locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }>;
    }> }) => (scan.results ?? []).map(result => ({
      kind: 'check' as const, source: scan.tool.driver.name, name: result.message.text ?? result.ruleId ?? 'Finding',
      status: result.level ?? 'warning', location: result.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    })));
    for (const finding of findings) journal.record(run.id, finding);
    journal.record(run.id, { kind: 'check', source: 'SARIF', name: 'Imported security report', status: findings.length + ' findings' });
    await journal.flush();
    await vscode.window.showInformationMessage('Attached ' + findings.length + ' findings to the run record.');
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.checkCandidate', async () => {
    const proposal = review.pending;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!proposal || !root) throw new Error('Open a proposal and accept the hunks to test first.');
    const image = await vscode.window.showInputBox({ prompt: 'Local Docker image containing pytest and project dependencies' });
    if (!image) return;
    if (review.pending !== proposal) throw new Error('The proposal changed. Open the current proposal.');
    const ids = proposal.hunks.filter(h => h.decision === 'accepted').map(h => h.id);
    const name = 'pytest ' + proposal.key + ' hunks ' + ids.join(', ');
    try {
      const { checkCandidate } = await import('./review/candidateCheck');
      await checkCandidate(root.uri.fsPath, proposal, image);
      journal?.record(proposal.runId, { kind: 'check', source: image, name, status: 'passed' });
      await vscode.window.showInformationMessage('Candidate tests passed for the selected hunks.');
    } catch (error) {
      journal?.record(proposal.runId, { kind: 'check', source: image, name, status: 'failed' });
      throw error;
    }
  }));
  const runs = new RunManager({
    record: journal?.record,
    tf, review, cfg,
    askCommandApproval: async (argv) =>
      (await vscode.window.showInformationMessage(`Agent wants to run: ${argv.join(' ')}`, 'Allow', 'Deny')) === 'Allow',
  });
  runsRef = runs;
  const token = await getOrCreateToken(ctx.secrets);
  const mcp = await startServer({
    port: cfg.mcpPort,
    token,
    registerTools: makeToolRegistrar({ index, review, runs, post }),
  });
  mcpHandle = mcp;
  const FAILURE_KEY = 'contexo.simulatedPrimaryFailure';
  const setup = new SetupController({
    post, token, mcpPort: mcp.port, index,
    failureStore: { get: () => ctx.globalState.get<boolean>(FAILURE_KEY, false), set: (v) => ctx.globalState.update(FAILURE_KEY, v) },
  });
  const sessions = new SessionController({
    inspector: createSessionInspector(cfg),
    post,
    currentRun: () => {
      const r = runs.active;
      if (!r) return { ids: [], sealed: [] };
      const sealed = r.sealedSessions.filter((x) => !!x);
      return { ids: [...new Set([...sealed, r.sessionId].filter((x) => !!x))], sealed };
    },
  });
  setupRef = setup;
  registerInlineEdit(ctx, runs);
  registerDevCommands(ctx, { post, review, runs, tf });

  let bannerShown = false;
  runs.on('state', (s) => {
    if (s.state === 'starting') bannerShown = false;
    if (s.banner && s.state === 'streaming' && !bannerShown) {
      bannerShown = true;
      void vscode.window.showWarningMessage(s.banner);
    }
    status.update(s);
    post({ type: 'runState', ...s });
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled' || s.state === 'awaiting-review') {
      void sessions.refreshCurrent().catch((e) => log('session refresh failed', String(e)));
    }
  });
  runs.on('stream', (events) => post({ type: 'stream', events }));
  runs.on('session', (s) => {
    post({ type: 'session', ...s });
    void sessions.refreshCurrent().catch((e) => log('session refresh failed', String(e)));
  });

  ctx.subscriptions.push(
    panel.onMessage((m) => {
      switch (m.type) {
        case 'send':
          if (runs.active && runs.active.state !== 'done') void runs.send(m.text).catch((e) => log('send failed', e));
          else void runs.start('agent', m.text).catch((e) => log('start failed', e));
          break;
        case 'stop':
          void runs.stop();
          break;
        case 'openSource': {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) break;
          const uri = vscode.Uri.joinPath(folder.uri, m.path);
          const line = Math.max(0, m.line);
          void vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) });
          break;
        }
        case 'undo':
          void vscode.commands.executeCommand('contexo.undoHunk', m.hunkId);
          break;
        case 'redo':
          void vscode.commands.executeCommand('contexo.redoHunk', m.hunkId);
          break;
        case 'ready':
          post({ type: 'changes', hunks: review.undo.list() });
          setup.onReady();
          break;
        case 'sessionLoad':
          void sessions.show(m.sessionIds).catch((e) => log('session load failed', String(e)));
          break;
        case 'setupRefresh':
        case 'startTrueForge':
        case 'stopTrueForge':
        case 'openTrueForge':
        case 'saveProvider':
        case 'setModels':
        case 'register':
        case 'updateSetting':
        case 'simulateFailure':
          void setup.handle(m).catch((e) => log('setup message failed', e instanceof Error ? e.message : String(e)));
          break;
      }
    }),
    vscode.commands.registerCommand('contexo.stop', () => runs.stop()),
    vscode.commands.registerCommand('contexo.copyMcpConnection', async () => {
      const text = [
        `URL: ${mcp.url}`,
        `Header: X-Contexo-Token: ${token}`,
        '',
        '# PowerShell (repo root; also set PRIMARY_MODEL and FALLBACK_MODEL):',
        `$env:CONTEXO_TOKEN="${token}"; node extension/trueforge/register.mjs`,
        '',
        '# bash:',
        `CONTEXO_TOKEN="${token}" node extension/trueforge/register.mjs`,
      ].join('\n');
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Contexo MCP URL and token copied to the clipboard.');
    }),
    vscode.commands.registerCommand('contexo.openSetup', async () => {
      await vscode.commands.executeCommand('contexo.panel.focus');
      setup.showSetup();
    }),
    vscode.commands.registerCommand('contexo.reindex', () => index.reindexAll()),
    vscode.commands.registerCommand('contexo.stopTrueForge', async () => {
      if (runs.active && runs.active.state !== 'done') await runs.stop();
      void vscode.window.showInformationMessage(await setup.stopTrueForge());
    }),
  );
  log(`Contexo activated; MCP at ${mcp.url}`);
  void setup.init().catch((e) => log('setup init failed', e instanceof Error ? e.message : String(e)));
}

export async function deactivate(): Promise<void> {
  const runs = runsRef;
  if (runs?.active && runs.active.state !== 'done') await runs.stop();
  await setupRef?.dispose();
  setupRef = undefined;
  await mcpHandle?.stop();
  mcpHandle = undefined;
}
