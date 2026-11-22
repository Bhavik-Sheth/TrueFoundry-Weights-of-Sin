/**
 * review/undoSnapshots.ts - pure (no vscode) snapshot helpers behind merge-aware undo.
 *
 * Exports:
 *  - ApplySnapshot: before/after text of one file for one review apply.
 *  - SNAPSHOT_LIMIT (20); appendSnapshots(existing, added): append and evict the oldest beyond the cap.
 *  - findSnapshot(snaps, hunkId, path): newest snapshot containing the hunk on that path.
 *  - uncoveredHunks(live, snaps): live hunks with no snapshot (undo run is all-or-nothing).
 *  - foldUndo(current, snaps): fold snapshots newest -> oldest through threeWay; {ok:false} on conflict.
 */
import { threeWay } from './threeWay';

export interface ApplySnapshot {
  applyId: string;
  runId: string;
  path: string;
  before: string;
  after: string;
  hunkIds: string[];
  at: number;
}

export const SNAPSHOT_LIMIT = 20;

export function appendSnapshots(existing: readonly ApplySnapshot[], added: readonly ApplySnapshot[]): ApplySnapshot[] {
  return [...existing, ...added].slice(-SNAPSHOT_LIMIT);
}

export function findSnapshot(snaps: readonly ApplySnapshot[], hunkId: string, path: string): ApplySnapshot | undefined {
  return [...snaps].reverse().find((s) => s.path === path && s.hunkIds.includes(hunkId));
}

export function uncoveredHunks<T extends { hunkId: string; path: string }>(live: readonly T[], snaps: readonly ApplySnapshot[]): T[] {
  return live.filter((h) => !findSnapshot(snaps, h.hunkId, h.path));
}

/** Undo every snapshot of one file, newest first, folding into `current`; stops at the first conflict. */
export async function foldUndo(
  current: string, snaps: readonly ApplySnapshot[],
): Promise<{ ok: true; text: string } | { ok: false; path: string; text: string }> {
  let text = current;
  for (const snap of [...snaps].sort((a, b) => b.at - a.at)) {
    const r = await threeWay(text, snap.after, snap.before);
    if (!r.clean) return { ok: false, path: snap.path, text: r.text };
    text = r.text;
  }
  return { ok: true, text };
}
