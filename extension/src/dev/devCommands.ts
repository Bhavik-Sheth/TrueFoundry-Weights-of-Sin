/**
 * dev/devCommands.ts - fixture-driven developer commands (visible when contexo.devMode is on).
 *
 * Exports:
 *  - registerDevCommands(ctx, deps): registers
 *    contexo.dev.pingTrueForge (tf.ping -> info message),
 *    contexo.dev.sendTestTurn (input box -> runs.start('agent', text)),
 *    contexo.dev.showSamplePacket (posts samplePacket to the Context tab),
 *    contexo.dev.openSampleProposal (active editor text -> sampleProposalArgs -> applyEditExact ->
 *      review.setDoc on contexo-base:/sample/<path> and contexo-proposed:/sample/<path> -> vscode.diff),
 *    contexo.dev.applySampleChange (posts sampleApplied to the Changes tab).
 *
 * Rules: no writes to the workspace.
 * Depends on: dev/fixtures, review/proposal, review/diffView (type), run/runManager (type), run/tfClient (type), types, log.
 * Depended on by: extension.
 */
import * as vscode from 'vscode';
import type { ToWebview } from '../types';
import type { ReviewEngine } from '../review/diffView';
import type { RunManager } from '../run/runManager';
import type { TfClient } from '../run/tfClient';
import { log } from '../log';
import { applyEditExact } from '../review/proposal';
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
    let proposed = text;
    try {
      for (const e of args.edits) proposed = applyEditExact(proposed, e.oldText, e.newText);
    } catch (e) {
      void vscode.window.showErrorMessage(`Contexo (dev): ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const baseUri = `contexo-base:/sample/${rel}`;
    const propUri = `contexo-proposed:/sample/${rel}`;
    deps.review.setDoc(baseUri, text);
    deps.review.setDoc(propUri, proposed);
    log('[dev] opening sample proposal for', rel);
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(baseUri),
      vscode.Uri.parse(propUri),
      `${rel} · Contexo sample proposal (${args.edits.length} edits)`,
    );
  });

  reg('contexo.dev.applySampleChange', () => {
    deps.post({ type: 'changes', hunks: sampleApplied });
  });
}
