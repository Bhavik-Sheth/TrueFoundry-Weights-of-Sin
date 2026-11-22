/**
 * historyGuard.test.ts - tests for src/history/historyGuard.ts (pure history concern detection).
 */
import { describe, expect, it } from 'vitest';
import { detectConcern, needsHistoryCheck, parseBlamePorcelain } from '../src/history/historyGuard';
import type { Hunk } from '../src/types';

function hunk(lines: string[]): Hunk {
  return { id: 'h', path: 'a.py', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines, outsideSelection: false, decision: 'pending' };
}

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FIXTURE = [
  `${A} 10 10 2`, 'author X', 'summary s', 'filename f.py', '\tline ten',
  `${A} 11 11`, 'filename f.py', '\tline eleven',
  `${B} 5 12 1`, 'author Y', 'filename f.py', '\tline twelve',
  `${ZERO} 13 13 1`, 'author Not Committed Yet', 'filename f.py', '\tline thirteen',
  '',
].join('\n');

describe('historyGuard', () => {
  it('needsHistoryCheck: 3 removed lines or a guard line', () => {
    expect(needsHistoryCheck(hunk(['-a', '-b', '-c', '+d']))).toBe(true);
    expect(needsHistoryCheck(hunk(['-a', '+b']))).toBe(false);
    expect(needsHistoryCheck(hunk(['-    if not lock.acquire():', '+pass']))).toBe(true);
    expect(needsHistoryCheck(hunk(['-    # HACK: keep for py3.9', '+']))).toBe(true);
    expect(needsHistoryCheck(hunk(['-a', '-b', '+c']), 2)).toBe(true);
    expect(needsHistoryCheck(hunk(['+if x:', ' keep']))).toBe(false);
  });
  it('parseBlamePorcelain groups lines and skips uncommitted', () => {
    expect(parseBlamePorcelain(FIXTURE)).toEqual([{ sha: A, lines: [10, 11] }, { sha: B, lines: [12] }]);
  });
  it('detectConcern finds keyword, issues and squash PR', () => {
    expect(detectConcern('Fix race in reloader (#5012)', 'Closes #412. See GH-77.'))
      .toEqual({ concern: 'race', issues: ['#412', '#77'], prs: [5012] });
    expect(detectConcern('Tidy imports', '')).toEqual({ concern: null, issues: [], prs: [] });
  });
});
