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
import { registerImpact } from './context/impact';
import { registerWorkbench } from './review/workbench';
import { registerReview } from './review/diffView';
import { createSessionInspector, createTfClient } from './run/tfClient';
import { registerAssistant } from './shell/chatParticipant';
import { RunManager } from './run/runManager';
import { RunRoutes } from './mcp/runRoutes';
import { reviewCheckpointKey } from './run/reviewCheckpoint';
import type { ReviewCheckpoint } from './run/reviewCheckpoint';
import { getOrCreateToken, startServer } from './mcp/server';
import type { McpHandle } from './mcp/server';
import { makeToolRegistrar } from './mcp/tools';
import { registerInlineEdit } from './shell/inlineEdit';
import { registerDevCommands } from './dev/devCommands';
import { SetupController } from './shell/setupController';
import { SessionController } from './shell/sessionController';

import { RunJournal } from './run/journal';
import { registerReplay } from './replay/commands';
import { registerEvidence } from './review/evidence';
import { registerIntegrations } from './review/integrations';
import { matchingHunks, normalizeReviewPath, reviewCoordinates } from './review/matching';
import { rebuildFile, sha256 } from './review/proposal';
import { compareProposalImpact } from './review/impactGraph';
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
  registerImpact(ctx);
  const review = registerReview(ctx, post);
  review.index = index;
  const routes = new RunRoutes();
  const routeConfig = {
    routes, port: cfg.mcpPort,
    save: (route: { sessionId?: string; connector: string; token: string }) => ctx.secrets.store('contexo.reviewRoute', JSON.stringify({
      sessionId: route.sessionId, connector: route.connector, token: route.token, port: routeConfig.port,
    })),
    load: async (sessionId: string) => {
      const stored = await ctx.secrets.get('contexo.reviewRoute');
      if (!stored) return undefined;
      const route = JSON.parse(stored);
      return route.sessionId === sessionId ? route : undefined;
    },
  };
  const tf = createTfClient(cfg, routeConfig);
  const journalDirectory = ctx.storageUri && vscode.Uri.joinPath(ctx.storageUri, 'runs').fsPath;
  const journal = journalDirectory
    ? new RunJournal(journalDirectory, error => console.error('Contexo run recording failed', error))
    : undefined;
  journalRef = journal;
  registerWorkbench(ctx, review, journal, () => runsRef?.active?.id);
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.compareProposalImpact', async () => {
    const proposal = review.pending;
    if (!proposal) throw new Error('Open a proposal and accept the hunks to compare.');
    const snapshot = structuredClone(proposal);
    const comparison = await compareProposalImpact(snapshot, index.symbols());
    journal?.record(snapshot.runId, {
      kind: 'impact', proposalKey: snapshot.key,
      hunkIds: snapshot.hunks.filter(hunk => hunk.decision === 'accepted').map(hunk => hunk.id),
      comparison,
    });
    await journal?.flush();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
      language: 'json', content: JSON.stringify(comparison, null, 2),
    }));
  }));
  if (journalDirectory && journal) registerReplay(ctx, journalDirectory, journal);
  if (journal) registerEvidence(ctx, journal, () => review.pending);
  review.onProposal = p => {
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (p.status !== 'reviewing' && saved?.proposal.key === p.key && saved.run.id === p.runId) {
      void ctx.workspaceState.update(reviewCheckpointKey, undefined).then(undefined, error => log('Could not clear review checkpoint', String(error)));
    }
    journal?.record(p.runId, {
    kind: 'proposal',
    proposal: { key: p.key, toolCallId: p.toolCallId, hunks: p.hunks, status: p.status, result: p.result },
    bases: p.files.map(file => ({ path: file.path, hash: file.baseHash })),
    });
  };
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
    const reviewed = review.pending;
    const selection = await vscode.window.showOpenDialog({ filters: { SARIF: ['sarif', 'json'] }, canSelectMany: false });
    if (!selection?.length) return;
    const report = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(selection[0])).toString('utf8'));
    if (report.version !== '2.1.0' || !Array.isArray(report.runs)) {
      throw new Error('Expected a SARIF 2.1.0 report.');
    }
    type SarifLocation = {
      artifactLocation?: { uri?: string; uriBaseId?: string };
      region?: { startLine?: number; endLine?: number };
    };
    const findings = report.runs.flatMap((scan: { tool: { driver: { name: string } }; results?: Array<{
      ruleId?: string; level?: string; message: { text?: string };
      properties?: { contexoSha256?: string; contexoSide?: 'base' | 'candidate' };
      locations?: Array<{ physicalLocation?: SarifLocation }>;
    }> }) => (scan.results ?? []).flatMap(result => {
      const locations = result.locations?.length ? result.locations : [{}];
      return locations.map(({ physicalLocation }) => ({
        source: scan.tool.driver.name, name: result.message.text ?? result.ruleId ?? 'Finding',
        status: result.level ?? 'warning', physicalLocation, properties: result.properties,
      }));
    }));
    for (const finding of findings) {
      const { physicalLocation, properties, ...evidence } = finding;
      const artifact = physicalLocation?.artifactLocation;
      const reported = artifact?.uri;
      const location = reported && !artifact?.uriBaseId ? normalizeReviewPath(reported) : undefined;
      const startLine = physicalLocation?.region?.startLine;
      const endLine = physicalLocation?.region?.endLine ?? startLine;
      const side = properties?.contexoSide;
      const revision = properties?.contexoSha256;
      const file = reviewed?.runId === run.id ? reviewed.files.find(file => file.path === location) : undefined;
      let hunkIds: string[] = [];
      if (reviewed && file && location && startLine !== undefined && endLine !== undefined &&
          Number.isInteger(startLine) && Number.isInteger(endLine) && startLine > 0 && endLine >= startLine &&
          (side === 'base' || side === 'candidate')) {
        const text = side === 'base' ? file.base : rebuildFile(file.base, file.path, reviewed.hunks);
        if (revision === sha256(text)) {
          const coordinateHunks = reviewCoordinates(reviewed.hunks, location, side);
          hunkIds = matchingHunks(coordinateHunks, { path: location, startLine, endLine, side });
        }
      }
      journal.record(run.id, { kind: 'check', ...evidence, location: location ?? reported, startLine, endLine, side, revision,
        proposalKey: hunkIds.length ? reviewed?.key : undefined, hunkIds });
    }
    journal.record(run.id, { kind: 'check', source: 'SARIF', name: 'Imported security report', status: findings.length + ' findings' });
    await journal.flush();
    await vscode.window.showInformationMessage('Attached ' + findings.length + ' findings to the run record.');
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.checkCandidate', async () => {
    const proposal = review.pending;
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!proposal || !root) throw new Error('Open a proposal and accept the hunks to test first.');
    const answer = await vscode.window.showWarningMessage('Run pytest on a temporary copy with accepted hunks? Tests run with your local account permissions.', { modal: true }, 'Run pytest');
    if (answer !== 'Run pytest') return;
    if (review.pending !== proposal) throw new Error('The proposal changed. Open the current proposal.');
    const ids = proposal.hunks.filter(h => h.decision === 'accepted').map(h => h.id);
    const name = 'pytest ' + proposal.key + ' hunks ' + ids.join(', ');
    try {
      const { checkCandidate } = await import('./review/candidateCheck');
      await checkCandidate(root.uri.fsPath, proposal);
      journal?.record(proposal.runId, { kind: 'check', source: 'local pytest', name, status: 'passed' });
      await vscode.window.showInformationMessage('Candidate tests passed for the selected hunks.');
    } catch (error) {
      journal?.record(proposal.runId, { kind: 'check', source: 'local pytest', name, status: 'failed' });
      throw error;
    }
  }));
  const runs = new RunManager({
    record: journal?.record,
    tf, review, cfg,
    askCommandApproval: async (argv) =>
      (await vscode.window.showInformationMessage(`Agent wants to run: ${argv.join(' ')}`, 'Allow', 'Deny')) === 'Allow',
  });
  const ask = async (provided?: string) => {
    const text = typeof provided === 'string' ? provided : await vscode.window.showInputBox({ prompt: 'What should the Contexo assistant do?' });
    if (!text?.trim()) return;
    if (runs.active && runs.active.state !== 'done') await runs.send(text);
    else await runs.start('agent', text);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.ask', ask));
  runsRef = runs;
  registerAssistant(ctx, runs);
  const rootId = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  review.persistDecision = async proposal => {
    const root = rootId();
    if (!root) return;
    const saved = runs.checkpoint(proposal, root);
    if (saved) await ctx.workspaceState.update(reviewCheckpointKey, saved);
  };
  review.validateApply = async proposal => {
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (saved?.proposal.key === proposal.key && saved.run.id === proposal.runId && saved.root !== rootId()) {
      throw new Error('The workspace root changed after this proposal was staged.');
    }
    await runs.confirmReview(proposal);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.restorePendingReview', async () => {
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (!saved) throw new Error('There is no pending review to restore.');
    if (saved.root !== rootId()) throw new Error('Open the original workspace root to restore this review.');
    if (ctx.workspaceState.get('review.apply.v1')) throw new Error('An interrupted file apply still needs recovery.');
    await runs.restoreReview(saved);
  }));
  if (journal) registerIntegrations(ctx, journal, () => runs.active);
  const token = await getOrCreateToken(ctx.secrets);
  const mcp = await startServer({
    port: cfg.mcpPort,
    token,
    lookupRoute: connector => routes.get(connector),
    registerTools: (server, route) => makeToolRegistrar({ index, review, runs, post }, { requireRoute: true, route })(server),
  });
  mcpHandle = mcp;
  routeConfig.port = mcp.port;
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
        case 'reviewAction': {
          const commands = new Map(Object.entries({
            workbench: 'openWorkbench', check: 'checkCandidate', restore: 'restorePendingReview',
            sync: 'syncReviewEvidence', replay: 'replayRun', import: 'importRun',
          }));
          const command = commands.get(m.action);
          if (command) void vscode.commands.executeCommand('contexo.' + command).then(undefined, error =>
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
          break;
        }
        case 'send':
          void ask(m.text).catch(error => log('Assistant request failed', error));
          break;
        case 'stop':
          void runs.stop();
          break;
        case 'openSource': {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (!folder) break;
          const uri = vscode.Uri.joinPath(folder.uri, m.path);
          const line = Math.max(0, m.line - 1);
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
          if (runs.active) post({ type: 'runState', state: runs.active.state, agent: runs.active.agent });
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
  void setup.init().then(async () => {
    if (ctx.workspaceState.get(reviewCheckpointKey) && !ctx.workspaceState.get('review.apply.v1')) {
      const choice = await vscode.window.showInformationMessage('Contexo has an unfinished review.', 'Restore Review');
      if (choice) await vscode.commands.executeCommand('contexo.restorePendingReview');
    }
  }).catch((error: unknown) => log('Contexo activation follow-up failed', String(error)));
}

export async function deactivate(): Promise<void> {
  const runs = runsRef;
  if (runs?.active?.state === 'streaming') await runs.stop();
  await journalRef?.flush().catch(error => log('Journal flush failed', String(error)));
  await setupRef?.dispose();
  setupRef = undefined;
  await mcpHandle?.stop();
  mcpHandle = undefined;
}
