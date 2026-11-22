/**
 * historyGuard.test.ts - tests for src/history/historyGuard.ts (pure history concern detection).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capWhyExists, detectConcern, explainRange, needsHistoryCheck, parseBlamePorcelain } from '../src/history/historyGuard';
import type { Hunk } from '../src/types';
import type { WhyExists } from '../src/history/historyGuard';

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

describe('detectConcern word boundaries', () => {
  it('does not match keywords inside other words', () => {
    expect(detectConcern('Add trace logging', '').concern).toBeNull();
  });
});

describe('explainRange', () => {
  let dir = '';
  let plainDir = '';
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.io', ...a], { cwd: dir });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-why-'));
    plainDir = mkdtempSync(join(tmpdir(), 'ctx-plain-'));
    git('init');
    writeFileSync(join(dir, 'm.py'), ['a', 'b', 'c', 'd', 'e', ''].join('\n'));
    git('add', 'm.py');
    git('commit', '-m', 'Fix race in loader (#9)', '-m', 'Closes #412');
    writeFileSync(join(dir, 'n.py'), 'x');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });
  it('explains committed lines', async () => {
    const w = await explainRange(dir, 'm.py', 2, 4);
    expect(w.commits[0].subject).toBe('Fix race in loader (#9)');
    expect(w.commits[0].lines).toEqual([2, 4]);
    expect(w).toMatchObject({ concern: 'race', issues: ['#412'], prs: [9] });
  });
  it('uncommitted file -> note, no throw', async () => {
    expect(await explainRange(dir, 'n.py', 1, 1)).toMatchObject({ commits: [], concern: null, note: 'uncommitted' });
  });
  it('not a git repo -> note no-git', async () => {
    expect((await explainRange(plainDir, 'x.py', 1, 1)).note).toBe('no-git');
  });
});

describe('capWhyExists', () => {
  it('keeps the JSON within the cap even with oversized issues', () => {
    const w: WhyExists = {
      commits: [{ sha: 'a', author: 'A', date: '2020-01-01', subject: 's', bodyExcerpt: 'b'.repeat(300), lines: [1, 2] }],
      issues: Array.from({ length: 2000 }, (_, i) => `#${i}`),
      prs: [], tests: [], concern: 'race',
    };
    expect(JSON.stringify(capWhyExists(w)).length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(capWhyExists({ ...w, issues: ['#1'] })).length).toBeLessThanOrEqual(4000);
    expect(capWhyExists({ ...w, issues: ['#1'] }).commits).toHaveLength(1);
  });
});
