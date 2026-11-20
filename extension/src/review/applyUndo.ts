/**
 * review/applyUndo.ts - C4 writing and undo/redo of accepted hunks.
 *
 * S4 status: all REAL. Pure helpers reverseHunkPatch / applyHunkPatch / undoPatchOn; pickHunk QuickPick.
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
import { applyPatch, formatPatch, parsePatch, reversePatch } from 'diff';
import type { AppliedHunk, Hunk, ToWebview } from '../types';
import { log } from '../log';
import { sha256 } from './proposal';

function resolveUri(rel: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('No workspace folder open');
  return vscode.Uri.joinPath(root, ...rel.split('/'));
}

/** Pure: swap +/- lines and old/new ranges of a stored single-hunk patch. */
export function reverseHunkPatch(patch: string): string {
  return formatPatch(reversePatch(parsePatch(patch)[0]));
}

/** Pure: apply a stored single-hunk patch to text; null if it does not apply cleanly. */
export function applyHunkPatch(current: string, patch: string): string | null {
  const r = applyPatch(current, parsePatch(patch)[0]);
  return r === false ? null : r;
}

/** Pure: text after undoing the hunk (null if the file changed at this hunk). */
export function undoPatchOn(current: string, patch: string): string | null {
  return applyHunkPatch(current, reverseHunkPatch(patch));
}

function firstChanged(patch: string): string {
  const l = patch.split(/\r?\n/).find((x) => /^[+-]/.test(x) && !/^(\+\+\+|---)/.test(x));
  return l ? l.trim() : '';
}

function patchLine(patch: string): string {
  const m = patch.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return m ? m[1] : '?';
}

export async function pickHunk(stack: UndoStack, mode: 'undo' | 'redo'): Promise<string | undefined> {
  const items = stack
    .list()
    .filter((h) => h.undone === (mode === 'redo'))
    .sort((a, b) => b.appliedAt - a.appliedAt)
    .map((h) => ({ label: `${h.path}:${patchLine(h.patch)}`, description: firstChanged(h.patch), hunkId: h.hunkId }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(mode === 'undo' ? 'No applied changes to undo.' : 'No undone changes to redo.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: mode === 'undo' ? 'Undo which change?' : 'Redo which change?' });
  return pick?.hunkId;
}

export class UndoStack {
  private history: AppliedHunk[] = [];

  constructor(private post: (m: ToWebview) => void = () => {}, private storage?: vscode.Memento) {
    this.history = storage?.get<AppliedHunk[]>('review.history.v1', []) ?? [];
  }

  private async saveHistory(): Promise<void> {
    const hunks = this.list();
    this.post({ type: 'changes', hunks });
    await this.storage?.update('review.history.v1', hunks);
  }

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
      if (!await doc.save()) throw new Error('Could not save ' + uri.fsPath);
      if (sha256(doc.getText()) !== sha256(text)) log('external-transform: saved text differs from expected for', uri.fsPath);
    }
  }

  async recordApplied(runId: string, hunks: Hunk[]): Promise<void> {
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
    await this.saveHistory();
  }

  private async readCurrent(rel: string): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(resolveUri(rel));
    return doc.getText();
  }

  private async change(id: string, undo: boolean): Promise<boolean> {
    const rec = this.history.find((h) => h.hunkId === id);
    if (!rec || rec.undone === undo) return false;
    let next: string | null;
    try {
      const cur = await this.readCurrent(rec.path);
      next = undo ? undoPatchOn(cur, rec.patch) : applyHunkPatch(cur, rec.patch);
    } catch (e) {
      log('undo read failed', rec.path, String(e));
      next = null;
    }
    if (next === null) {
      void vscode.window.showWarningMessage(`Cannot ${undo ? 'undo' : 'redo'} automatically: ${rec.path} changed at this hunk`);
      return false;
    }
    await this.applyFiles(new Map([[rec.path, next]]));
    rec.undone = undo;
    await this.saveHistory();
    return true;
  }

  undoHunk(id: string): Promise<boolean> {
    return this.change(id, true);
  }

  redoHunk(id: string): Promise<boolean> {
    return this.change(id, false);
  }

  async undoLastApply(): Promise<void> {
    const live = this.history.filter((h) => !h.undone);
    if (live.length === 0) return;
    const at = Math.max(...live.map((h) => h.appliedAt));
    const group = live.filter((h) => h.appliedAt === at).reverse();
    for (const h of group) await this.undoHunk(h.hunkId);
  }

  list(): AppliedHunk[] {
    return this.history.map((h) => ({ ...h }));
  }
}
