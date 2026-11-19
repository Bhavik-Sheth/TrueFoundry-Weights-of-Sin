/**
 * review/applyUndo.ts - C4 writing and undo/redo of accepted hunks.
 *
 * S0 status: applyFiles REAL, recordApplied REAL (stores a forward single-hunk patch and posts 'changes'),
 * list REAL; undoHunk / redoHunk / undoLastApply are STUBS (Slice 4).
 *
 * Exports:
 *  - class UndoStack(post):
 *    - applyFiles(map): one WorkspaceEdit with a full-range replace per file (createFile for new files),
 *      then document.save() (no formatting); logs 'external-transform' if the saved text hash differs.
 *    - recordApplied(runId, hunks): push AppliedHunk records (forward unified patch of each hunk).
 *    - undoHunk(hunkId) / redoHunk(hunkId): apply reversed / forward patch with jsdiff applyPatch to
 *      current text; if it does not apply cleanly show "Cannot undo automatically: file changed at
 *      this hunk" and leave the file alone.
 *    - undoLastApply(): undo all hunks of the latest apply in reverse order.
 *    - list(): history; each change posts a changes message to the panel.
 *
 * Rules: in-memory history only (lost on reload, documented limitation). Paths are workspace-relative POSIX.
 * Depends on: vscode, diff, review/proposal, types, log. Depended on by: review/diffView, shell/panel.
 */
import * as vscode from 'vscode';
import { formatPatch } from 'diff';
import type { AppliedHunk, Hunk, ToWebview } from '../types';
import { log } from '../log';
import { sha256 } from './proposal';

function resolveUri(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('No workspace folder open');
  return vscode.Uri.joinPath(root, ...rel.split('/'));
}

export class UndoStack {
  private history: AppliedHunk[] = [];

  constructor(private post: (m: ToWebview) => void = () => {}) {}

  async applyFiles(m: Map<string, string>): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const docs: Array<{ uri: vscode.Uri; text: string }> = [];
    for (const [rel, text] of m) {
      const uri = resolveUri(rel);
      let existing: vscode.TextDocument | undefined;
      try {
        existing = await vscode.workspace.openTextDocument(uri);
      } catch {
        existing = undefined;
      }
      if (existing) {
        const full = new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length));
        edit.replace(uri, full, text);
      } else {
        edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), text);
      }
      docs.push({ uri, text });
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('workspace.applyEdit returned false');
    for (const { uri, text } of docs) {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      if (sha256(doc.getText()) !== sha256(text)) log('external-transform: saved text differs from expected for', uri.fsPath);
    }
  }

  recordApplied(runId: string, hunks: Hunk[]): void {
    const now = Date.now();
    for (const h of hunks) {
      const patch = formatPatch({
        oldFileName: h.path,
        newFileName: h.path,
        oldHeader: '',
        newHeader: '',
        hunks: [{ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines }],
      });
      this.history.push({ hunkId: h.id, path: h.path, runId, patch, appliedAt: now, undone: false });
    }
    this.post({ type: 'changes', hunks: this.list() });
  }

  async undoHunk(id: string): Promise<boolean> {
    log('[stub] undoHunk', id);
    return false;
  }

  async redoHunk(id: string): Promise<boolean> {
    log('[stub] redoHunk', id);
    return false;
  }

  async undoLastApply(): Promise<void> {
    log('[stub] undoLastApply');
  }

  list(): AppliedHunk[] {
    return [...this.history];
  }
}
