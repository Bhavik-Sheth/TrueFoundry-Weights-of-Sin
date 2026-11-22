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
import { workspaceRoot, hasNativeFiles, selectWorkspaceRoot } from './shell/workspaceRoot';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { log } from './log';
import type { ToWebview } from './types';
import { ContexoPanelProvider } from './shell/panel';
import { StatusBar } from './shell/statusBar';
import { startIndexing } from './context/indexer';
import { registerImpact } from './context/impact';
import { registerWorkbench } from './review/workbench';
import { readLive, registerReview } from './review/diffView';
import { createSessionInspector, createTfClient } from './run/tfClient';
import { registerAssistant } from './shell/chatParticipant';
import { RunManager } from './run/runManager';
import { createAdmin } from './run/trueforgeAdmin';
import { RunRoutes } from './mcp/runRoutes';
import { reviewCheckpointKey } from './run/reviewCheckpoint';
import type { ReviewCheckpoint } from './run/reviewCheckpoint';
import { assertNativeWorkspacePath, getOrCreateToken, startServer } from './mcp/server';
import type { McpHandle } from './mcp/server';
import { makeToolRegistrar } from './mcp/tools';
import { registerInlineEdit } from './shell/inlineEdit';
import { EditorAgentBridge, registerCopilotBridge } from './shell/agentBridge';
import { registerDevCommands } from './dev/devCommands';
import { SetupController } from './shell/setupController';
import { SessionController } from './shell/sessionController';

import { BatchPlans, proposalOutput } from './run/batchPlan';
import { RunJournal } from './run/journal';
import { startupPrompt, unfinishedRun } from './run/startupPrompt';
import { registerReplay } from './replay/commands';
import { registerEvidence } from './review/evidence';
import { registerIntegrations } from './review/integrations';
import { matchingHunks, reviewCoordinates } from './review/matching';
import { rebuildFile, sha256 } from './review/proposal';
import { compareProposalImpact } from './review/impactGraph';
import { wiringWithSymbols } from './review/wiring';
import { checksFromJournal, summarizeProposal } from './review/summary';
import { reduceRequirements, requirementsFromRecords } from './review/requirements';
import { readReplay } from './replay/records';
import { parseSarif } from './review/sarif';
import { regeneratePrompt } from './review/regenerate';
import { rankMentions } from './context/mentions';
import { startLoopMonitor } from './metrics';

let indexRef: ReturnType<typeof startIndexing> | undefined;
let journalRef: RunJournal | undefined;
let mcpHandle: McpHandle | undefined;
let runsRef: RunManager | undefined;
let setupRef: SetupController | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const cfg = getConfig();
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.showRuntimeCapabilities', async () => {
    const runtime = await createAdmin(getConfig().trueforgeUrl).inspectRuntime();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
      content: JSON.stringify(runtime, null, 2), language: 'json',
    }));
  }));
  const panel = new ContexoPanelProvider(ctx);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(ContexoPanelProvider.viewId, panel));
  const post = (m: ToWebview) => panel.post(m);
  const status = new StatusBar();
  ctx.subscriptions.push(status);
  const savedRoot = ctx.workspaceState.get<string>('contexo.selectedWorkspace');
  const initialRoot = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === savedRoot);
  if (initialRoot) selectWorkspaceRoot(initialRoot.uri);
  const loopMonitor = startLoopMonitor();
  ctx.subscriptions.push(loopMonitor);
  const index = indexRef = startIndexing();
  let cachedPaths: Promise<string[]> | undefined;
  const invalidatePaths = () => { cachedPaths = undefined; };
  const workspacePaths = () => cachedPaths ??= (async () => {
    const folder = workspaceRoot();
    if (!folder) return [];
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'), '**/{.git,node_modules,.venv}/**', 5000);
    return uris.map(uri => vscode.workspace.asRelativePath(uri, false).replace(/[\\]/g, '/'));
  })().catch(error => { log('Could not list workspace files for mentions', String(error)); return []; });
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
  const requirementKinds = new Set(['requirement', 'requirement-link', 'proposal', 'tool-output']);
  let requirementTimer: ReturnType<typeof setTimeout> | undefined;
  let requirementRunId: string | undefined;
  let requirementRead = 0;
  ctx.subscriptions.push({ dispose() {
    clearTimeout(requirementTimer);
    if (journal) journal.onRecord = undefined;
    requirementRunId = undefined;
  } });
  const readRequirements = async (runId: string) => {
    if (!journal) return [];
    return reduceRequirements(readReplay(await journal.read(runId)).records);
  };
  const pushRequirements = (runId: string) => {
    if (requirementRunId !== runId) return;
    const read = ++requirementRead;
    void readRequirements(runId).then(items => {
      if (requirementRunId !== runId || requirementRead !== read) return;
      const pending = review.pending?.runId === runId ? review.pending : undefined;
      post({ type: 'requirements', runId, items, pendingHunks: pending?.hunks.map(h => ({ id: h.id, path: h.path, line: h.newStart })) });
    }, error => log('Could not read requirements', String(error)));
  };
  if (journal) {
    journal.onRecord = (runId, evidence) => {
      if (runId !== requirementRunId || !requirementKinds.has(evidence.kind)) return;
      clearTimeout(requirementTimer);
      requirementTimer = setTimeout(() => pushRequirements(runId), 200);
    };
  }
  review.flushEvidence = journal ? () => journal.flush() : undefined;
  const batchPlans = new Map<string, BatchPlans>();
  const batchesFor = (workspace?: string) => {
    const root = vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === workspace)?.uri;
    if (!workspace || !root || !journal) return undefined;
    let batches = batchPlans.get(workspace);
    if (!batches) {
      batches = new BatchPlans(journal, workspace, path => readLive(path, root));
      batchPlans.set(workspace, batches);
    }
    return batches;
  };
  review.validateProposal = async (run, args) => {
    if (run.origin !== 'external') await batchesFor(run.workspaceUri)?.assertScope(run, args.edits);
  };
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
  review.onFinish = p => post({ type: 'reviewClosed', key: p.key });
  review.onProposal = p => {
    agentBridge?.finish(p);
    if (p.status === 'reviewing') {
      wiringWithSymbols(p, index.symbols()).then(
        async ({ wiring, before, after }) => {
          const checks = await journal?.read(p.runId).then(checksFromJournal, () => []) ?? [];
          if (p.status === 'reviewing') post({ type: 'review', key: p.key, wiring, summary: summarizeProposal(p, wiring, checks, before, after) });
        },
        error => log('Could not build wiring map', String(error)));
    }
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (p.status !== 'reviewing' && saved?.proposal.key === p.key && saved.run.id === p.runId) {
      void ctx.workspaceState.update(reviewCheckpointKey, undefined).then(undefined, error => log('Could not clear review checkpoint', String(error)));
    }
    journal?.record(p.runId, {
    kind: 'proposal',
    proposal: { key: p.key, toolCallId: p.toolCallId, hunks: p.hunks, status: p.status, result: p.result },
    bases: p.files.map(file => ({ path: file.path, hash: file.baseHash })),
    output: p.status === 'applied' ? proposalOutput(p) : undefined,
    });
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.openRunRecord', async () => {
    const ids = await journal?.list() ?? [];
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
    const workspace = run.workspaceUri ?? rootId();
    if (!workspace) throw new Error('Open the workspace for this run.');
    const stat = await vscode.workspace.fs.stat(selection[0]);
    if (stat.size > 16 * 1024 * 1024) throw new Error('SARIF imports are limited to 16 MiB.');
    const bytes = await vscode.workspace.fs.readFile(selection[0]);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('SARIF imports are limited to 16 MiB.');
    const findings = parseSarif(JSON.parse(Buffer.from(bytes).toString('utf8')), workspace);
    for (const finding of findings) {
      const { location, reportedUri, startLine, endLine, side, revision, ...evidence } = finding;
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
      journal.record(run.id, { kind: 'check', ...evidence, location: location ?? reportedUri, startLine, endLine, side, revision,
        proposalKey: hunkIds.length ? reviewed?.key : undefined, hunkIds });
    }
    journal.record(run.id, { kind: 'check', source: 'SARIF', name: 'Imported security report', status: findings.length + ' findings' });
    await journal.flush();
    await vscode.window.showInformationMessage('Attached ' + findings.length + ' findings to the run record.');
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.checkCandidate', async () => {
    const proposal = review.pending;
    const root = workspaceRoot();
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
  const rootId = () => workspaceRoot()?.uri.toString();
  let agentBridge: EditorAgentBridge | undefined;
  const runs = new RunManager({
    record: journal?.record, flushEvidence: journal ? () => journal.flush() : undefined,
    tf, review, cfg, workspaceUri: rootId,
    askCommandApproval: async (argv) =>
      (await vscode.window.showInformationMessage(`Agent wants to run: ${argv.join(' ')}`, 'Allow', 'Deny')) === 'Allow',
  });
  let indexedRoot = rootId();
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.selectWorkspaceRoot', async (uri?: vscode.Uri) => {
    const folders = vscode.workspace.workspaceFolders?.filter(folder => hasNativeFiles(folder.uri)) ?? [];
    const choices = folders.map(folder => ({
      label: folder.name, description: folder.uri.fsPath, folder,
    }));
    const picked = uri ? choices.find(choice => choice.folder.uri.toString() === uri.toString())
      : await vscode.window.showQuickPick(choices, { placeHolder: 'Choose the workspace folder Contexo should use' });
    if (!picked || picked.folder.uri.toString() === rootId()) return;
    const state = runs.active?.state;
    if (review.pending || review.isApplying || state === 'streaming' || state === 'awaiting-review') {
      throw new Error('Finish the current run or review before switching workspace folders.');
    }
    selectWorkspaceRoot(picked.folder.uri);
    indexedRoot = rootId();
    post({ type: 'changes', hunks: review.undo.list() });
    invalidatePaths();
    await Promise.all([index.reindexAll(), ctx.workspaceState.update('contexo.selectedWorkspace', indexedRoot)]);
  }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const run = runs.active;
    if (run?.workspaceUri && run.workspaceUri !== rootId()) void runs.stop();
    if (indexedRoot !== rootId()) {
      indexedRoot = rootId();
      post({ type: 'changes', hunks: review.undo.list() });
      invalidatePaths();
      void index.reindexAll();
    }
  }));
  const ask = async (provided?: string) => {
    const text = typeof provided === 'string' ? provided : await vscode.window.showInputBox({ prompt: 'What should the Contexo assistant do?' });
    if (!text?.trim()) return;
    if (runs.active && runs.active.state !== 'done') await runs.send(text);
    else await runs.start('agent', text);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.ask', ask));
  runsRef = runs;
  registerWorkbench(ctx, review, journal, runs, cfg.trueforgeUrl);
  registerAssistant(ctx, runs);
  agentBridge = new EditorAgentBridge(ctx.workspaceState, review, runs, journal?.record);
  review.persistDecision = async (proposal, run) => {
    const root = run.workspaceUri ?? rootId();
    if (!root) return;
    if (root !== rootId()) throw new Error('The run belongs to a different workspace.');
    await journal?.checkpointReview(proposal, root);
    if (run.origin === 'external') {
      await agentBridge!.persist(proposal, run);
      return;
    }
    const saved = runs.checkpoint(proposal, root);
    if (saved) await ctx.workspaceState.update(reviewCheckpointKey, saved);
  };
  review.validateApply = async proposal => {
    if (await agentBridge?.validate(proposal)) return;
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (saved?.proposal.key === proposal.key && saved.run.id === proposal.runId && saved.root !== rootId()) {
      throw new Error('The workspace root changed after this proposal was staged.');
    }
    await runs.confirmReview(proposal);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.restorePendingReview', async () => {
    const saved = ctx.workspaceState.get<ReviewCheckpoint>(reviewCheckpointKey);
    if (!saved) {
      if (await agentBridge?.restore()) return;
      throw new Error('There is no pending review to restore.');
    }
    if (saved.root !== rootId()) throw new Error('Open the original workspace root to restore this review.');
    if (ctx.workspaceState.get('review.apply.v1')) throw new Error('An interrupted file apply still needs recovery.');
    await runs.restoreReview(saved);
  }));
  if (journal) registerIntegrations(ctx, journal, () => runs.active);
  const token = await getOrCreateToken(ctx.secrets);
  const agentToken = agentBridge.workspaceId
    ? await getOrCreateToken(ctx.secrets, 'contexo.editorAgent.' + sha256(agentBridge.workspaceId))
    : undefined;
  const mcp = await startServer({
    port: cfg.mcpPort,
    token,
    lookupRoute: connector => routes.get(connector),
    agent: agentToken ? {
      token: agentToken,
      registerTools: makeToolRegistrar({ index, review, runs, post }, { external: agentBridge }),
    } : undefined,
    registerTools: (server, route) => makeToolRegistrar({ index, review, runs, post, journal, batchesFor }, { requireRoute: true, route })(server),
  });
  mcpHandle = mcp;
  routeConfig.port = mcp.port;
  if (agentToken) registerCopilotBridge(ctx, mcp.url + '/agent', agentToken);
  const FAILURE_KEY = 'contexo.simulatedPrimaryFailure';
  const setup = new SetupController({
    post, token, mcpPort: mcp.port, index,
    metrics: () => {
      const { p50Ms, p95Ms } = loopMonitor.snapshot();
      return { loopP50Ms: p50Ms, loopP95Ms: p95Ms, lastStopMs: runs.lastStopMs, lastIndexMs: index.lastIndexMs };
    },
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
    const runId = runs.active?.id;
    if (runId && runId !== requirementRunId) {
      clearTimeout(requirementTimer);
      requirementRunId = runId;
      post({ type: 'requirements', runId, items: [] });
      pushRequirements(runId);
    }
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled' || s.state === 'awaiting-review') {
      void sessions.refreshCurrent().catch((e) => log('session refresh failed', String(e)));
    }
  });
  runs.on('stream', (events) => post({ type: 'stream', events }));
  let lastStale: { path: string; summary?: string } | undefined;
  review.onStale = (path, summary) => {
    lastStale = { path, summary };
    runs.emit('stream', [{ kind: 'action', action: 'regenerate', path, label: 'Regenerate' }]);
  };
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
        case 'mentionQuery': {
          const request = workspacePaths();
          void request.then(paths => {
            if (request === cachedPaths) post({ type: 'mentionResults', q: m.q, items: rankMentions(m.q, index.symbols(), paths) });
          });
          break;
        }
        case 'send':
          void ask(m.text).catch(error => log('Assistant request failed', error));
          break;
        case 'regenerate':
          void ask(regeneratePrompt(m.path, lastStale?.path === m.path ? lastStale.summary : undefined))
            .catch(error => log('Assistant request failed', error));
          break;
        case 'stop':
          void runs.stop();
          break;
        case 'linkRequirement': {
          const proposal = review.pending;
          if (!journal || !proposal || !proposal.hunks.some(hunk => hunk.id === m.hunkId)) break;
          void (async () => {
            const requirement = requirementsFromRecords(readReplay(await journal.read(proposal.runId)).records).find(r => r.id === m.requirementId);
            if (!requirement) return;
            journal.record(proposal.runId, {
              kind: 'requirement-link', requirementId: requirement.id, requirementText: requirement.text, requirementRevision: requirement.revision,
              proposalKey: proposal.key, hunkIds: [m.hunkId], checkSequences: [], source: 'human', linked: m.linked === true,
            });
          })().catch(error => log('Could not link requirement', String(error)));
          break;
        }
        case 'openSource': {
          const folder = workspaceRoot();
          if (!folder) break;
          if (typeof m.path !== 'string' || !m.path || /[\x00-\x1f\\:]/.test(m.path) ||
              m.path.startsWith('/') || m.path.split('/').some(part => part === '..' || part === '.git') ||
              !Number.isSafeInteger(m.line) || m.line < 1) break;
          const line = m.line - 1;
          void (async () => {
            try {
              if (hasNativeFiles(folder.uri)) await assertNativeWorkspacePath(folder.uri.fsPath, m.path);
              const uri = vscode.Uri.joinPath(folder.uri, m.path);
              await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) });
            } catch {
              void vscode.window.showWarningMessage('Contexo could not open this workspace source reference.');
            }
          })();
          break;
        }
        case 'undo':
          void vscode.commands.executeCommand('contexo.undoHunk', m.hunkId);
          break;
        case 'undoRun':
          void review.undo.undoRun(m.runId);
          break;
        case 'redo':
          void vscode.commands.executeCommand('contexo.redoHunk', m.hunkId);
          break;
        case 'ready':
          if (runs.active) post({ type: 'runState', state: runs.active.state, agent: runs.active.agent });
          if (runs.active) pushRequirements(runs.active.id);
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
    vscode.commands.registerCommand('contexo.reindex', () => { invalidatePaths(); return index.reindexAll(); }),
    vscode.commands.registerCommand('contexo.stopTrueForge', async () => {
      if (runs.active && runs.active.state !== 'done') await runs.stop();
      void vscode.window.showInformationMessage(await setup.stopTrueForge());
    }),
  );
  log(`Contexo activated; MCP at ${mcp.url}`);
  void setup.init().then(async () => {
    const applyPending = !!ctx.workspaceState.get('review.apply.v1');
    const reviewPending = !!ctx.workspaceState.get(reviewCheckpointKey);
    const unfinished = applyPending || reviewPending ? undefined
      : await journal?.lastRuns(1).then(([records]) => records && unfinishedRun(records), () => undefined);
    const prompt = startupPrompt({ applyPending, reviewPending, unfinished });
    if (!prompt) return;
    const choice = await vscode.window.showInformationMessage(prompt.message, ...prompt.actions.filter(a => a !== 'Dismiss'));
    try {
      if (choice === 'Recover') await review.recoverApply();
      else if (choice === 'Restore Review') await vscode.commands.executeCommand('contexo.restorePendingReview');
      else if (choice === 'Resume' && unfinished) {
        await runs.start('agent', `Continue the unfinished task from run ${unfinished.runId}: "${unfinished.request}". Call batch_plan with action "status" and fromRunId "${unfinished.runId}" if a plan exists, otherwise call resume_context, then re-read files before editing.`);
      }
    } catch (error) {
      log('Contexo startup action failed', String(error));
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (choice === 'Recover') post({ type: 'changes', hunks: review.undo.list() });
    }
  }).catch((error: unknown) => log('Contexo activation follow-up failed', String(error)));
}

export async function deactivate(): Promise<void> {
  await indexRef?.dispose();
  indexRef = undefined;
  const runs = runsRef;
  if (runs?.active?.state === 'streaming') await runs.stop();
  await journalRef?.close().catch(error => log('Journal flush failed', String(error)));
  await setupRef?.dispose();
  setupRef = undefined;
  await mcpHandle?.stop();
  mcpHandle = undefined;
}
