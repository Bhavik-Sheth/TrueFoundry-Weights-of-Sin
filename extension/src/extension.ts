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
import { createTfClient } from './run/tfClient';
import { RunManager } from './run/runManager';
import { getOrCreateToken, startServer } from './mcp/server';
import type { McpHandle } from './mcp/server';
import { makeToolRegistrar } from './mcp/tools';
import { registerInlineEdit } from './shell/inlineEdit';
import { registerDevCommands } from './dev/devCommands';

let mcpHandle: McpHandle | undefined;
let runsRef: RunManager | undefined;

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
  const runs = new RunManager({ tf, review, cfg });
  runsRef = runs;
  const token = await getOrCreateToken(ctx.secrets);
  const mcp = await startServer({
    port: cfg.mcpPort,
    token,
    registerTools: makeToolRegistrar({ index, review, runs, post }),
  });
  mcpHandle = mcp;
  registerInlineEdit(ctx, runs);
  registerDevCommands(ctx, { post, review, runs, tf });

  runs.on('state', (s) => {
    status.update(s);
    post({ type: 'runState', ...s });
  });
  runs.on('stream', (events) => post({ type: 'stream', events }));
  runs.on('session', (s) => post({ type: 'session', ...s }));

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
    vscode.commands.registerCommand('contexo.reindex', () => index.reindexAll()),
  );
  log(`Contexo activated; MCP at ${mcp.url}`);
}

export async function deactivate(): Promise<void> {
  const runs = runsRef;
  if (runs?.active && runs.active.state !== 'done') await runs.stop();
  await mcpHandle?.stop();
  mcpHandle = undefined;
}
