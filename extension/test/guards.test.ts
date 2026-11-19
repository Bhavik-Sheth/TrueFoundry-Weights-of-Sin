/**
 * guards.test.ts - tests for src/review/guards.ts (C4). Needs `npm run build` first (parser wasm from dist/).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { Parser } from 'web-tree-sitter';
import { loadParser } from '../src/context/indexer';
import type { IndexApi } from '../src/context/indexer';
import { PYTHON_BUILTINS, scopeGuard, symbolCheck } from '../src/review/guards';
import { buildHunks } from '../src/review/proposal';
import type { Hunk, Selection, SymbolEntry } from '../src/types';

let parser: Parser;
beforeAll(async () => {
  parser = await loadParser(path.join(__dirname, '..', 'dist'));
});

const idx = (syms: Array<Partial<SymbolEntry>> = []): IndexApi => ({
  ready: Promise.resolve(),
  symbols: () => syms as SymbolEntry[],
  byName: (n) => (syms as SymbolEntry[]).filter((s) => s.name?.toLowerCase() === n.toLowerCase()),
  inFile: () => [],
  enclosing: () => undefined,
  reindexFile: async () => {},
  reindexAll: async () => {},
});

/** Proposal turning `base` into `proposed` for pkg/mod.py. */
const check = (base: string, proposed: string, index = idx()) =>
  symbolCheck([{ path: 'pkg/mod.py', base, proposed, baseHash: 'h' }], index, { parser });

describe('PYTHON_BUILTINS', () => {
  it('contains common builtins and exceptions', () => {
    for (const n of ['len', 'print', 'isinstance', 'ValueError', 'None']) expect(PYTHON_BUILTINS.has(n)).toBe(true);
  });
  it('does not contain arbitrary names', () => {
    expect(PYTHON_BUILTINS.has('undefined_helper')).toBe(false);
  });
});

describe('symbolCheck', () => {
  const base = 'def f(a):\n    return a\n';

  it('detects a missing call with its proposed-side line', async () => {
    expect(await check(base, 'def f(a):\n    undefined_helper()\n    return a\n')).toEqual([
      'MISSING_SYMBOL undefined_helper @ pkg/mod.py:2',
    ]);
  });

  it('passes builtins, same-proposal defs, imports, parameters and loop variables', async () => {
    const proposed = [
      'import os',
      'from json import loads as parse',
      'import a.b',
      'def f(a, *args, cb=None, **kw):',
      '    n = len(a)',
      '    added(n)',
      '    os.path.join("x")',
      '    parse("{}")',
      '    a.b.c()',
      '    cb()',
      '    for fn in args:',
      '        fn()',
      '    with open("x") as h:',
      '        h()',
      '    try:',
      '        pass',
      '    except ValueError as exc:',
      '        exc()',
      '    g = lambda q: q()',
      '    [m() for m in args]',
      '    if (w := cb):',
      '        w()',
      '    return g',
      '',
      'def added(x):',
      '    return x',
      '',
      'class K:',
      '    def helper(self): ...',
      '    use = helper',
      '    @staticmethod',
      '    def s(): ...',
      '    def run(self):',
      '        super().run()',
      '        self.helper()',
      '',
    ].join('\n');
    expect(await check('', proposed)).toEqual([]);
  });

  it('ignores attribute calls', async () => {
    expect(await check(base, 'def f(a):\n    a.undefined_method()\n    return a\n')).toEqual([]);
  });

  it('tolerates star imports', async () => {
    expect(await check(base, 'from helpers import *\ndef f(a):\n    mystery()\n    return a\n')).toEqual([]);
  });

  it('checks decorator names and ignores unchanged lines', async () => {
    const p = 'def f(a):\n    return a\n\n@missing_deco\ndef g(): ...\n';
    expect(await check(base, p)).toEqual(['MISSING_SYMBOL missing_deco @ pkg/mod.py:4']);
    // a pre-existing bad call on a context line is not reported
    expect(await check('def f():\n    old_bad()\n', 'def f():\n    old_bad()\n    print(1)\n')).toEqual([]);
  });

  it('reports a name defined elsewhere in the workspace but not imported', async () => {
    const index = idx([{ name: 'helper_fn', path: 'pkg/util.py', kind: 'function' }]);
    expect(await check(base, 'def f(a):\n    helper_fn()\n    return a\n', index)).toEqual([
      'MISSING_SYMBOL helper_fn @ pkg/mod.py:2 (defined in pkg/util.py but not imported)',
    ]);
    expect(await check(base, 'from pkg.util import helper_fn\ndef f(a):\n    helper_fn()\n    return a\n', index)).toEqual([]);
  });

  it('returns every violation and skips non-python files', async () => {
    const out = await check(base, 'def f(a):\n    one()\n    two()\n    return a\n');
    expect(out).toHaveLength(2);
    const md = await symbolCheck([{ path: 'README.md', base: '', proposed: 'foo()\n', baseHash: 'new' }], idx(), { parser });
    expect(md).toEqual([]);
  });
});

describe('scopeGuard', () => {
  const sel: Selection = { path: 'pkg/mod.py', startLine: 1, endLine: 3, docVersion: 1, hash: 'h', text: '' };
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`).join('\n') + '\n';
  const edited = (from: Record<number, string>, n = 40) => {
    const a = lines(n).split('\n');
    for (const [i, t] of Object.entries(from)) a[Number(i)] = t;
    return a.join('\n');
  };

  it('flags only the hunk outside the selection (two hunks, one in, one out)', () => {
    const hunks = buildHunks('pkg/mod.py', lines(40), edited({ 2: 'CHANGED in selection', 30: 'CHANGED far away' }), 'h');
    expect(hunks).toHaveLength(2);
    scopeGuard(hunks, sel);
    expect(hunks.map((h) => h.outsideSelection)).toEqual([false, true]);
  });

  it('falls back to the old range when a hunk has no line detail', () => {
    const mk = (oldStart: number): Hunk => ({ id: 'x', path: 'p', oldStart, oldLines: 1, newStart: oldStart, newLines: 1, lines: [], outsideSelection: false, decision: 'pending' });
    const hs = [mk(3), mk(20)]; // oldStart 3 -> 0-based line 2 (inside 1..3), 20 -> line 19 (outside)
    scopeGuard(hs, sel);
    expect(hs.map((h) => h.outsideSelection)).toEqual([false, true]);
  });
});
