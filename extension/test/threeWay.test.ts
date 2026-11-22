import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { threeWay } from '../src/review/threeWay';
import { undoHunkText } from '../src/review/applyUndo';
import { buildHunks, sha256 } from '../src/review/proposal';
import { formatPatch } from 'diff';

describe('threeWay', () => {
  it('clean merge keeps unrelated user edit', async () => {
    const base = 'a\nB\nc\nd\ne\n', current = 'a\nB\nc\nd\nE-user\n', other = 'a\nb\nc\nd\ne\n';
    expect(await threeWay(current, base, other)).toEqual({ clean: true, text: 'a\nb\nc\nd\nE-user\n' });
  });
  it('overlap yields conflict markers', async () => {
    const r = await threeWay('a\nX\n', 'a\nB\n', 'a\nb\n');
    expect(r.clean).toBe(false);
    expect(r.text).toContain('<<<<<<< current');
  });
  it('preserves CRLF', async () => {
    const r = await threeWay('a\r\nB\r\nc\r\nz\r\n', 'a\r\nB\r\nc\r\nd\r\n', 'a\r\nb\r\nc\r\nd\r\n');
    expect(r).toEqual({ clean: true, text: 'a\r\nb\r\nc\r\nz\r\n' });
  });
});

describe('undoHunkText', () => {
  it('reverses only that hunk', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const after = before.replace('line 5\n', 'line 5 new\n').replace('line 35\n', 'line 35 new\n');
    const [h1, h2] = buildHunks('a.ts', before, after, sha256(before));
    const patch = formatPatch({
      oldFileName: 'a.ts', newFileName: 'a.ts', oldHeader: '', newHeader: '',
      hunks: [{ oldStart: h2.oldStart, oldLines: h2.oldLines, newStart: h2.newStart, newLines: h2.newLines, lines: h2.lines }],
    });
    const snap = { applyId: 'x', runId: 'r', path: 'a.ts', before, after, hunkIds: [h1.id, h2.id], at: 1 };
    expect(undoHunkText(snap, patch)).toBe(before.replace('line 5\n', 'line 5 new\n'));
  });
});
