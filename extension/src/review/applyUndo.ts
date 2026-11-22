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
 *    - applyFiles(m, expected, meta): with meta {runId, hunkIds} also stores an ApplySnapshot per file (last 20).
 *    - undoHunk falls back to a three-way merge preview (threeWay) against the snapshot when the direct
 *      reverse patch fails; undoRun(runId) folds a run's snapshots newest -> oldest, all-or-nothing.
 *  - undoHunkText(snapshot, patch): pure; snapshot.after with only that hunk reversed.
 *  - re-exports type ApplySnapshot (helpers live in review/undoSnapshots).
 *    - list(): history; each change posts a changes message to the panel.
 *
 * Rules: in-memory history only (lost on reload, documented limitation). Paths are workspace-relative POSIX.
 * Depends on: vscode, diff, review/proposal, types, log. Depended on by: review/diffView, shell/panel.
 */
import { workspaceRoot, hasNativeFiles } from '../shell/workspaceRoot';
import * as vscode from 'vscode';
import { applyPatch, formatPatch, parsePatch, reversePatch } from 'diff';
import type { AppliedHunk, Hunk, ToWebview } from '../types';
import { log } from '../log';
import { sha256 } from './proposal';
import { assertNativeWorkspacePath, resolveUnder } from '../mcp/server';
import { threeWay } from './threeWay';
import { appendSnapshots, findSnapshot, foldUndo, uncoveredHunks, type ApplySnapshot } from './undoSnapshots';

export type { ApplySnapshot };

const SNAPSHOT_KEY = 'undo.snapshots.v1';

function resolveUri(rel: string): vscode.Uri {
  const root = workspaceRoot()?.uri;
  if (!root) throw new Error('No workspace folder open');
  resolveUnder(root.fsPath, rel);
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

/** Pure: the snapshot's `after` text with only this hunk reversed (the `other` side of the merge). */
export function undoHunkText(snapshot: ApplySnapshot, patch: string): string {
  const r = undoPatchOn(snapshot.after, patch);
  if (r === null) throw new Error('The hunk does not apply to its apply snapshot.');
  return r;
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
  private snapshots: ApplySnapshot[] = [];

  constructor(private post: (m: ToWebview) => void = () => {}, private storage?: vscode.Memento) {
    this.history = storage?.get<AppliedHunk[]>('review.history.v1', []) ?? [];
    this.snapshots = storage?.get<ApplySnapshot[]>(SNAPSHOT_KEY, []) ?? [];
  }

  private async saveHistory(): Promise<void> {
    this.post({ type: 'changes', hunks: this.list() });
    await this.storage?.update('review.history.v1', this.history);
  }

  async applyFiles(m: Map<string, string>, expected?: ReadonlyMap<string, string>,
    meta?: { runId: string; hunkIds: ReadonlyMap<string, string[]> }): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    if (!m.size) return;
    const docs: Array<{ rel: string; uri: vscode.Uri; text: string; document?: vscode.TextDocument; version?: number; before: string }> = [];
    const root = workspaceRoot()?.uri;
    for (const [rel, text] of m) {
      const uri = resolveUri(rel);
      if (root && hasNativeFiles(root)) await assertNativeWorkspacePath(root.fsPath, rel);
      let existing: vscode.TextDocument | undefined;
      try {
        existing = await vscode.workspace.openTextDocument(uri);
      } catch {
        existing = undefined;
      }
      const base = expected?.get(rel);
      if (base !== undefined && base !== (existing ? sha256(existing.getText()) : 'new')) {
        throw new Error('STALE_BASE: ' + rel + ' changed before apply.');
      }
      if (existing) {
        const full = new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length));
        edit.replace(uri, full, text);
      } else {
        edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), text);
      }
      docs.push({ rel, uri, text, document: existing, version: existing?.version, before: existing?.getText() ?? '' });
    }
    if (workspaceRoot()?.uri.toString() !== root?.toString()) {
      throw new Error('The workspace changed before apply.');
    }
    for (const entry of docs) {
      if (entry.document && (entry.document.isClosed || entry.document.version !== entry.version)) {
        throw new Error('STALE_BASE: ' + entry.uri.path + ' changed before apply.');
      }
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error('workspace.applyEdit returned false');
    const saved: ApplySnapshot[] = [];
    for (const { rel, uri, text, before } of docs) {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!await doc.save()) throw new Error('Could not save ' + uri.fsPath);
      const disk = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
      if (doc.getText() !== text || disk !== text) {
        throw new Error('The saved file differs from the reviewed text: ' + uri.path);
      }
      const ids = meta?.hunkIds.get(rel);
      if (meta && ids?.length) {
        saved.push({ applyId: `${meta.runId}:${Date.now()}:${saved.length}:${rel}`, runId: meta.runId, path: rel,
          before, after: doc.getText(), hunkIds: [...ids], at: Date.now() });
      }
    }
    if (saved.length) {
      this.snapshots = appendSnapshots(this.snapshots, saved);
      await this.storage?.update(SNAPSHOT_KEY, this.snapshots);
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
      this.history.push({ hunkId: h.id, path: h.path, runId, workspaceUri: workspaceRoot()?.uri.toString(), patch, appliedAt: now, undone: false });
    }
    await this.saveHistory();
  }

  private async readCurrent(rel: string): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(resolveUri(rel));
    return doc.getText();
  }

  private async change(id: string, undo: boolean): Promise<boolean> {
    const rec = this.history.find(h => h.hunkId === id && this.inWorkspace(h));
    if (!rec || rec.undone === undo) return false;
    const root = workspaceRoot()?.uri.toString();
    let next: string | null;
    let currentHash = '';
    try {
      const cur = await this.readCurrent(rec.path);
      currentHash = sha256(cur);
      next = undo ? undoPatchOn(cur, rec.patch) : applyHunkPatch(cur, rec.patch);
    } catch (e) {
      log('undo read failed', rec.path, String(e));
      next = null;
    }
    if (next === null && undo) return this.mergeUndo(rec);
    if (next === null) {
      void vscode.window.showWarningMessage(`Cannot ${undo ? 'undo' : 'redo'} automatically: ${rec.path} changed at this hunk`);
      return false;
    }
    if (workspaceRoot()?.uri.toString() !== root) return false;
    await this.applyFiles(new Map([[rec.path, next]]), new Map([[rec.path, currentHash]]));
    rec.undone = undo;
    await this.saveHistory();
    return true;
  }

  private snapshotFor(rec: AppliedHunk): ApplySnapshot | undefined {
    return findSnapshot(this.snapshots, rec.hunkId, rec.path);
  }

  private async preview(rel: string, merged: string, title: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: merged });
    await vscode.commands.executeCommand('vscode.diff', resolveUri(rel), doc.uri, title);
  }

  /** Fallback when the direct reverse patch no longer applies: three-way merge against the apply snapshot. */
  private async mergeUndo(rec: AppliedHunk): Promise<boolean> {
    const snap = this.snapshotFor(rec);
    if (!snap) {
      void vscode.window.showWarningMessage('Cannot undo automatically: no snapshot for this apply (older than the last 20 applies).');
      return false;
    }
    const root = workspaceRoot()?.uri.toString();
    let current: string;
    let merged: { clean: boolean; text: string };
    try {
      current = await this.readCurrent(rec.path);
      merged = await threeWay(current, snap.after, undoHunkText(snap, rec.patch));
    } catch (e) {
      log('undo merge failed', rec.path, String(e));
      void vscode.window.showWarningMessage(`Cannot undo automatically: ${rec.path} could not be merged.`);
      return false;
    }
    await this.preview(rec.path, merged.text, 'Undo hunk (merged with your edits)');
    if (!merged.clean) {
      void vscode.window.showWarningMessage(`Undo conflicts with later edits in ${rec.path}; nothing was written.`);
      return false;
    }
    const pick = await vscode.window.showWarningMessage('Apply undo?', { modal: true }, 'Apply');
    if (pick !== 'Apply' || workspaceRoot()?.uri.toString() !== root) return false;
    await this.applyFiles(new Map([[rec.path, merged.text]]), new Map([[rec.path, sha256(current)]]));
    rec.undone = true;
    await this.saveHistory();
    return true;
  }

  /** Revert every live hunk of a run by folding its apply snapshots (newest first) into the current text. */
  async undoRun(runId: string): Promise<boolean> {
    const live = this.history.filter((h) => h.runId === runId && !h.undone && this.inWorkspace(h));
    if (live.length === 0) return false;
    const snaps = this.snapshots.filter((s) => s.runId === runId);
    if (uncoveredHunks(live, snaps).length > 0) {
      void vscode.window.showWarningMessage('Cannot undo run automatically: no snapshot for some of its applies (older than the last 20 applies).');
      return false;
    }
    const root = workspaceRoot()?.uri.toString();
    const out = new Map<string, string>();
    const hashes = new Map<string, string>();
    try {
      for (const path of new Set(live.map((h) => h.path))) {
        const original = await this.readCurrent(path);
        const r = await foldUndo(original, snaps.filter((s) => s.path === path && live.some((h) => h.path === path && s.hunkIds.includes(h.hunkId))));
        if (!r.ok) {
          await this.preview(path, r.text, 'Undo run (conflicts)');
          void vscode.window.showWarningMessage(`Undo conflicts with later edits in ${path}; nothing was written.`);
          return false;
        }
        const current = r.text;
        out.set(path, current);
        hashes.set(path, sha256(original));
      }
    } catch (e) {
      log('undo run failed', runId, String(e));
      void vscode.window.showWarningMessage('Cannot undo the run automatically: a merge failed.');
      return false;
    }
    for (const [path, text] of out) await this.preview(path, text, 'Undo run (merged with your edits)');
    const pick = await vscode.window.showWarningMessage('Apply undo?', { modal: true }, 'Apply');
    if (pick !== 'Apply' || workspaceRoot()?.uri.toString() !== root) return false;
    await this.applyFiles(out, hashes);
    for (const h of live) if (out.has(h.path)) h.undone = true;
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
    const live = this.history.filter(h => this.inWorkspace(h) && !h.undone);
    if (live.length === 0) return;
    const at = Math.max(...live.map((h) => h.appliedAt));
    const group = live.filter((h) => h.appliedAt === at).reverse();
    for (const h of group) await this.undoHunk(h.hunkId);
  }

  private inWorkspace(hunk: AppliedHunk) {
    return hunk.workspaceUri ? hunk.workspaceUri === workspaceRoot()?.uri.toString()
      : (vscode.workspace.workspaceFolders?.length ?? 0) <= 1;
  }

  list(): AppliedHunk[] {
    return this.history.filter(hunk => this.inWorkspace(hunk)).map((h) => ({ ...h }));
  }
}
