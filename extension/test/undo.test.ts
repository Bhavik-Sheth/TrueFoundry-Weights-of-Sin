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
