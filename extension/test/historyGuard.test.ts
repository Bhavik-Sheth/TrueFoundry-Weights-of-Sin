/**
 * historyGuard.test.ts - tests for src/history/historyGuard.ts (pure history concern detection).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capWhyExists, detectConcern, explainRange, historyGate, needsHistoryCheck, partitionAcceptAll, parseBlamePorcelain } from '../src/history/historyGuard';
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

describe('historyGate', () => {
  const h1: Hunk = { id: 'h1', path: 'a.py', oldStart: 10, oldLines: 3, newStart: 10, newLines: 0, lines: ['-a', '-b', '-c'], outsideSelection: false, decision: 'pending' };
  const w = (concern: boolean): WhyExists => ({
    commits: [{ sha: 'a'.repeat(40), author: 'x', date: '2020-01-01', subject: concern ? 'Fix race in loader (#9)' : 'Add loader', bodyExcerpt: concern ? 'See #412' : '', lines: [10, 12] }],
    issues: [], prs: [], tests: [], concern: null,
  });
  const ex = new Map([['h1', w(true)]]);

  it('denies once, then flags', () => {
    const denied = new Set<string>();
    const first = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: undefined, denied });
    expect(first.deny).toMatch(/^HISTORY_CONCERN a\.py:10-12 commit aaaaaaa "Fix race in loader \(#9\)" \(#412\)\./);
    const second = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: undefined, denied });
    expect(second.deny).toBeUndefined();
    expect(second.flags.get(h1.id)).toMatchObject({ sha: 'a'.repeat(40), concern: 'race' });
  });
  it('acknowledged commit stages with acknowledgement text', () => {
    const r = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: [{ commit: 'aaaaaaa', reason: 'lock kept in caller' }], denied: new Set() });
    expect(r.deny).toBeUndefined();
    expect(r.flags.get(h1.id)?.acknowledgement).toBe('lock kept in caller');
  });
  it('short commit prefix does not acknowledge', () => {
    const r = historyGate({ runId: 'r', hunks: [h1], explains: ex, acknowledged: [{ commit: 'aaa', reason: 'x' }], denied: new Set() });
    expect(r.deny).toBeDefined();
  });
  it('no concern -> no deny, no flags', () => {
    const r = historyGate({ runId: 'r', hunks: [h1], explains: new Map([['h1', w(false)]]), acknowledged: undefined, denied: new Set() });
    expect(r.deny).toBeUndefined();
    expect(r.flags.size).toBe(0);
  });
});

describe('partitionAcceptAll', () => {
  const mk = (id: string, read?: boolean): Hunk => ({ id, path: 'a.py', oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: [], outsideSelection: false, decision: 'pending',
    ...(read === undefined ? {} : { historyConcern: { sha: 'a'.repeat(40), subject: 's', concern: 'race', issues: [], read } }) });
  it('holds back unread history hunks only', () => {
    const r = partitionAcceptAll([mk('plain'), mk('unread', false), mk('read', true)]);
    expect(r.accept.map((h) => h.id)).toEqual(['plain', 'read']);
    expect(r.held.map((h) => h.id)).toEqual(['unread']);
  });
});
