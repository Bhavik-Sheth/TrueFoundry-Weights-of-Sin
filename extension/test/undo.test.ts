import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { applyHunkPatch, undoPatchOn, reverseHunkPatch } from '../src/review/applyUndo';
import { buildHunks, sha256 } from '../src/review/proposal';
import { formatPatch } from 'diff';

const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const base = lines.join('\n') + '\n';
const proposed = base.replace('line 20\n', 'line 20 changed\n');
const [h] = buildHunks('a.ts', base, proposed, sha256(base));
const patch = formatPatch({
  oldFileName: 'a.ts', newFileName: 'a.ts', oldHeader: '', newHeader: '',
  hunks: [{ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines }],
});

describe('undo patches', () => {
  it('round trips apply -> undo -> redo', () => {
    expect(applyHunkPatch(base, patch)).toBe(proposed);
    expect(undoPatchOn(proposed, patch)).toBe(base);
    expect(applyHunkPatch(undoPatchOn(proposed, patch)!, patch)).toBe(proposed);
    expect(reverseHunkPatch(patch)).toContain('+line 20\n');
  });
  it('undo works after an unrelated edit far away', () => {
    const edited = proposed.replace('line 2\n', 'line 2 edited\n').replace('line 38\n', 'line 38 edited\nextra\n');
    const r = undoPatchOn(edited, patch);
    expect(r).toBe(base.replace('line 2\n', 'line 2 edited\n').replace('line 38\n', 'line 38 edited\nextra\n'));
  });
  it('undo fails cleanly after an edit inside the hunk', () => {
    expect(undoPatchOn(proposed.replace('line 20 changed', 'line 20 mine'), patch)).toBeNull();
  });
});

import { appendSnapshots, findSnapshot, uncoveredHunks, foldUndo, type ApplySnapshot } from '../src/review/undoSnapshots';

const snap = (n: number, over: Partial<ApplySnapshot> = {}): ApplySnapshot =>
  ({ applyId: 'a' + n, runId: 'r', path: 'f.ts', before: '', after: '', hunkIds: ['h' + n], at: n, ...over });

describe('undo snapshots', () => {
  it('caps at 20 and evicts the oldest', () => {
    let all: ApplySnapshot[] = [];
    for (let i = 1; i <= 21; i++) all = appendSnapshots(all, [snap(i)]);
    expect(all).toHaveLength(20);
    expect(all[0].applyId).toBe('a2');
    expect(all[19].applyId).toBe('a21');
  });
  it('lookup returns the newest snapshot containing the hunk and path', () => {
    const all = [snap(1, { hunkIds: ['x'] }), snap(2, { hunkIds: ['x'] }), snap(3, { hunkIds: ['x'], path: 'other.ts' })];
    expect(findSnapshot(all, 'x', 'f.ts')?.applyId).toBe('a2');
    expect(findSnapshot(all, 'nope', 'f.ts')).toBeUndefined();
  });
  it('coverage check reports uncovered hunks', () => {
    const live = [{ hunkId: 'h1', path: 'f.ts' }, { hunkId: 'h9', path: 'f.ts' }];
    expect(uncoveredHunks(live, [snap(1)])).toEqual([{ hunkId: 'h9', path: 'f.ts' }]);
    expect(uncoveredHunks([live[0]], [snap(1)])).toEqual([]);
  });
  it('fold of two applies restores the original and keeps an unrelated user edit', async () => {
    const v0 = 'a\nb\nc\nd\ne\nf\ng\n';
    const v1 = 'a\nB1\nc\nd\ne\nf\ng\n';
    const v2 = 'a\nB1\nc\nd\nE2\nf\ng\n';
    const user = 'a\nB1\nc\nd\nE2\nf\nG-user\n';
    const r = await foldUndo(user, [snap(1, { before: v0, after: v1 }), snap(2, { before: v1, after: v2 })]);
    expect(r).toEqual({ ok: true, text: 'a\nb\nc\nd\ne\nf\nG-user\n' });
  });
  it('fold aborts on conflict', async () => {
    const r = await foldUndo('a\nuser\n', [snap(1, { before: 'a\nb\n', after: 'a\nB\n' })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('f.ts');
  });
});
