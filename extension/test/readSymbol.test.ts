/**
 * readSymbol.test.ts - tests for resolveSymbol in src/context/readSymbol.ts (pure, fake index).
 */
import { describe, expect, it } from 'vitest';
import type { IndexApi } from '../src/context/indexer';
import { resolveSymbol } from '../src/context/readSymbol';
import type { SymbolEntry } from '../src/types';

const sym = (path: string, name: string, qualifiedName: string, kind: SymbolEntry['kind'] = 'method'): SymbolEntry =>
  ({ path, name, qualifiedName, kind, startLine: 3, endLine: 9 }) as SymbolEntry;

const idx = (syms: SymbolEntry[]): IndexApi => ({
  ready: Promise.resolve(),
  symbols: () => syms,
  byName: (n) => syms.filter((s) => s.name === n),
  inFile: () => [],
  enclosing: () => undefined,
  reindexFile: async () => {},
  reindexAll: async () => {},
});

const index = idx([
  sym('src/flask/cli.py', 'get_command', 'FlaskGroup.get_command'),
  sym('src/flask/app.py', 'get_command', 'AppGroup.get_command'),
  sym('src/flask/app.py', 'Flask', 'Flask', 'class'),
  sym('docs/a.md', 'Flask', 'Flask', 'doc'),
]);

describe('resolveSymbol', () => {
  it('matches an exact qualified name', () => {
    expect(resolveSymbol(index, 'FlaskGroup.get_command')).toMatchObject({ symbol: { path: 'src/flask/cli.py' } });
  });
  it('matches a module-qualified name', () => {
    expect(resolveSymbol(index, 'flask.cli.FlaskGroup.get_command')).toMatchObject({ symbol: { path: 'src/flask/cli.py' } });
  });
  it('returns candidates in index order for an ambiguous name', () => {
    expect(resolveSymbol(index, 'get_command')).toMatchObject({
      candidates: [{ qualifiedName: 'FlaskGroup.get_command', path: 'src/flask/cli.py', line: 3 }, { qualifiedName: 'AppGroup.get_command' }],
    });
  });
  it('matches a unique suffix of the qualified name', () => {
    const nested = idx([sym('a.py', 'm', 'Outer.Inner.m'), sym('b.py', 'go', 'B.go')]);
    expect(resolveSymbol(nested, 'Inner.m')).toMatchObject({ symbol: { path: 'a.py' } });
  });
  it('ignores doc symbols and reports NOT_FOUND', () => {
    expect(resolveSymbol(index, 'Flask')).toMatchObject({ symbol: { path: 'src/flask/app.py', kind: 'class' } });
    expect(resolveSymbol(index, 'nope')).toEqual({ error: 'NOT_FOUND' });
  });
  it('caps candidates at 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => sym(`m${i}.py`, 'f', `C${i}.f`));
    const r = resolveSymbol(idx(many), 'f');
    expect('candidates' in r && r.candidates).toHaveLength(10);
  });
});
