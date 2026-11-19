/**
 * dev/devCommands.ts - fixture-driven developer commands (visible when contexo.devMode is on).
 *
 * Exports:
 *  - registerDevCommands(ctx, deps): registers
 *    contexo.dev.pingTrueForge (tf.ping -> info message),
 *    contexo.dev.sendTestTurn (input box -> runs.start('agent', text)),
 *    contexo.dev.showSamplePacket (posts samplePacket to the Context tab),
 *    contexo.dev.openSampleProposal (active editor text -> sampleProposalArgs -> review.beginProposal with a
 *      fake inline Run selecting the first 10 lines; onResolve shows an info message + log; full review UI, no model),
 *    contexo.dev.openSampleProposalMissingSymbol (inserts `undefined_helper()` into the first function; shows the deny),
 *    contexo.dev.applySampleChange (posts sampleApplied to the Changes tab).
 *
 * Rules: no writes to the workspace.
 * Depends on: dev/fixtures, shell/inlineEdit, review/diffView (type), run/runManager (type), run/tfClient (type), types, log.
 * Depended on by: extension.
 */
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { ProposeArgs, Run, ToWebview } from '../types';
import type { ReviewEngine } from '../review/diffView';
import type { RunManager } from '../run/runManager';
import type { TfClient } from '../run/tfClient';
import { log } from '../log';
import { captureSelection } from '../shell/inlineEdit';
import { sampleApplied, samplePacket, sampleProposalArgs } from './fixtures';

export function registerDevCommands(
  ctx: vscode.ExtensionContext,
  deps: { post: (m: ToWebview) => void; review: ReviewEngine; runs: RunManager; tf: TfClient },
): void {
  const reg = (id: string, fn: () => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('contexo.dev.pingTrueForge', async () => {
    try {
      const ok = await deps.tf.ping();
      void vscode.window.showInformationMessage(ok ? 'Contexo: TrueForge reachable.' : 'Contexo: TrueForge did not respond OK.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Contexo: TrueForge ping failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  reg('contexo.dev.sendTestTurn', async () => {
    const text = await vscode.window.showInputBox({ prompt: 'Contexo (dev): message to send as an agent turn' });
    if (!text) return;
    await deps.runs.start('agent', text);
  });

  reg('contexo.dev.showSamplePacket', () => {
    deps.post({ type: 'packet', packet: samplePacket });
  });

  reg('contexo.dev.openSampleProposal', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Contexo (dev): open a file first.');
      return;
    }
    const text = editor.document.getText();
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
    const args = sampleProposalArgs(rel, text);
    if (args.edits.length === 0) {
      void vscode.window.showInformationMessage('Contexo (dev): file has no suitable lines to edit.');
      return;
    }
    const selection = captureSelection(editor);
    const lastLine = Math.min(9, editor.document.lineCount - 1);
    selection.startLine = 0;
    selection.endLine = lastLine;
    selection.text = editor.document.getText(new vscode.Range(0, 0, lastLine, editor.document.lineAt(lastLine).text.length));
    const run: Run = {
      id: `dev_${Date.now()}`,
      mode: 'inline',
      request: 'dev sample proposal',
      selection,
      sessionId: 'dev',
      agent: 'contexo',
      state: 'awaiting-review',
      sealedSessions: [],
    };
    deps.review.onResolve = (allow, reason) => {
      log('[dev] proposal resolved', allow, reason ?? '');
      void vscode.window.showInformationMessage(
        allow ? 'Contexo (dev): proposal applied.' : `Contexo (dev): proposal not applied (${reason ?? 'no reason'}).`,
      );
    };
    log('[dev] opening sample proposal for', rel);
    const r = await deps.review.beginProposal(run, 'dev_call', 'dev_thread', args);
    if (r !== 'reviewing') void vscode.window.showErrorMessage(`Contexo (dev): ${r.deny}`);
  });

  reg('contexo.dev.openSampleProposalMissingSymbol', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      void vscode.window.showInformationMessage('Contexo (dev): open a Python file first.');
      return;
    }
    const text = editor.document.getText();
    const m = /^([ \t]*)(?:async\s+)?def\s+\w+\(.*\)[^\n:]*:[ \t]*$/m.exec(text);
    if (!m) {
      void vscode.window.showInformationMessage('Contexo (dev): no single-line function signature found.');
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
    const args: ProposeArgs = {
      summary: 'dev: call an undefined helper',
      edits: [{
        path: rel,
        baseHash: createHash('sha256').update(text).digest('hex'),
        oldText: m[0],
        newText: `${m[0]}\n${m[1]}    undefined_helper()`,
      }],
    };
    const run: Run = {
      id: `dev_${Date.now()}`,
      mode: 'inline',
      request: 'dev missing-symbol proposal',
      selection: captureSelection(editor),
      sessionId: 'dev',
      agent: 'contexo',
      state: 'awaiting-review',
      sealedSessions: [],
    };
    const r = await deps.review.beginProposal(run, 'dev_call', 'dev_thread', args);
    if (r === 'reviewing') {
      void vscode.window.showWarningMessage('Contexo (dev): expected a MISSING_SYMBOL deny, but the diff opened.');
    } else {
      void vscode.window.showInformationMessage(`Contexo (dev): denied: ${r.deny}`);
    }
  });

  reg('contexo.dev.applySampleChange', () => {
    deps.post({ type: 'changes', hunks: sampleApplied });
  });
}
