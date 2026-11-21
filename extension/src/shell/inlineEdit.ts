/**
 * shell/inlineEdit.ts - C1 command contexo.inlineEdit (Ctrl+K E / Cmd+K E). REAL in S0.
 *
 * Exports:
 *  - registerInlineEdit(ctx, runs): registers the command.
 *  - captureSelection(editor): Selection - path (workspace-relative POSIX), 0-based inclusive line range,
 *    document version, SHA-256 of the full buffer, selected text.
 *
 * Rules: does nothing if a run is active or the selection is empty; no direct writes.
 * The instruction goes to runs.start('inline', text, selection); the first-message template
 * ([INLINE EDIT] ...) is built by RunManager/Slice 3, not here.
 * Depends on: types, review/proposal (sha256), run/runManager (type). Depended on by: extension.
 */
import * as vscode from 'vscode';
import type { Selection } from '../types';
import type { RunManager } from '../run/runManager';
import { sha256 } from '../review/proposal';

export function captureSelection(editor: vscode.TextEditor): Selection {
  const doc = editor.document;
  const sel = editor.selection;
  let endLine = sel.end.line;
  // A selection ending at column 0 of a line does not include that line.
  if (!sel.isEmpty && sel.end.character === 0 && endLine > sel.start.line) endLine -= 1;
  const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
  return {
    path: rel,
    startLine: sel.start.line,
    endLine,
    docVersion: doc.version,
    hash: sha256(doc.getText()),
    text: doc.getText(sel),
  };
}

export function registerInlineEdit(ctx: vscode.ExtensionContext, runs: RunManager): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('contexo.inlineEdit', async (provided?: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Contexo: select some code first.');
        return;
      }
      if (runs.active && runs.active.state !== 'done' && runs.active.state !== 'cancelled' && runs.active.state !== 'failed') {
        void vscode.window.showInformationMessage('Contexo: a run is already active. Stop it first.');
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root || vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() !== root.uri.toString()) {
        void vscode.window.showWarningMessage('Open the folder containing this file as the Contexo workspace to edit the selection.');
        return;
      }
      const selection = captureSelection(editor);
      const instruction = typeof provided === 'string' ? provided : await vscode.window.showInputBox({ prompt: 'Contexo: what should change?' });
      if (!instruction?.trim()) return;
      if (editor.document.isClosed || editor.document.version !== selection.docVersion) {
        void vscode.window.showWarningMessage('The selected file changed. Select the current text and retry.');
        return;
      }
      await runs.start('inline', instruction.trim(), selection);
    }),
  );
}
