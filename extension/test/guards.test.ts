/**
 * guards.test.ts - tests for src/review/guards.ts (C4).
 *
 * Real in S0: PYTHON_BUILTINS, stub no-op behaviour. Slice 6 behaviour is listed as it.todo.
 */
import { describe, expect, it } from 'vitest';
import { PYTHON_BUILTINS, scopeGuard, symbolCheck } from '../src/review/guards';
import type { Hunk, Selection } from '../src/types';

describe('PYTHON_BUILTINS', () => {
  it('contains common builtins and exceptions', () => {
    for (const n of ['len', 'print', 'isinstance', 'ValueError', 'None']) expect(PYTHON_BUILTINS.has(n)).toBe(true);
  });
  it('does not contain arbitrary names', () => {
    expect(PYTHON_BUILTINS.has('undefined_helper')).toBe(false);
  });
});

describe('S0 stubs', () => {
  const idx = { ready: Promise.resolve(), symbols: () => [], byName: () => [], inFile: () => [], enclosing: () => undefined, reindexFile: async () => {}, reindexAll: async () => {} };
  it('symbolCheck returns no violations', async () => {
    expect(await symbolCheck([], idx)).toEqual([]);
  });
  it('scopeGuard does not throw and leaves hunks untouched', () => {
    const h: Hunk = { id: 'x', path: 'p', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], outsideSelection: false, decision: 'pending' };
    const sel: Selection = { path: 'p', startLine: 0, endLine: 0, docVersion: 1, hash: 'h', text: '' };
    scopeGuard([h], sel);
    expect(h.outsideSelection).toBe(false);
  });
});

describe('slice 6 behaviour', () => {
  it.todo('missing symbol detected: MISSING_SYMBOL name @ path:line');
  it.todo('builtins, imports, locals, parameters, loop vars and defs added in the proposal pass');
  it.todo('names known in the index and importable pass; not imported is a violation');
  it.todo('star import tolerated; attribute calls skipped; decorator names checked');
  it.todo('scopeGuard flags only the hunk outside the selection (two hunks, one in, one out)');
});
