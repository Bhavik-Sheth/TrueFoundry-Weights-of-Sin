/**
 * mentions.test.ts - tests for src/context/mentions.ts (@ mention ranking).
 */
import { describe, expect, it } from 'vitest';
import { contextMentions, rankMentions } from '../src/context/mentions';
import type { SymbolEntry } from '../src/types';

const sym = (qualifiedName: string, kind: SymbolEntry['kind'] = 'function', path = 'src/flask/helpers.py', startLine = 10): SymbolEntry =>
  ({ id: qualifiedName + path, path, name: qualifiedName.split('.').pop()!, qualifiedName, kind, startLine, endLine: startLine + 3, decorators: [], calls: [], imports: [], text: '' });

const syms = [sym('get_debug_flag'), sym('FlaskGroup', 'class'), sym('get_debug_flag_docs', 'doc')];
const paths = ['src/flask/cli.py', 'README.md'];

describe('rankMentions', () => {
  it('ranks a symbol prefix match first with exact insert and detail', () => {
    const r = rankMentions('get_deb', syms, paths);
    expect(r[0]).toMatchObject({ kind: 'symbol', insert: '@get_debug_flag', label: 'get_debug_flag', detail: 'function · src/flask/helpers.py:10' });
    expect(r.some(i => i.insert === '@get_debug_flag_docs')).toBe(false);
  });
  it('ranks a file basename match', () => {
    expect(rankMentions('cli.py', syms, ['src/flask/cli.py', 'docs/cli.rst'])[0])
      .toMatchObject({ kind: 'file', insert: '@src/flask/cli.py', label: 'cli.py', detail: 'src/flask/cli.py' });
  });
  it('returns nothing for an empty query', () => {
    expect(rankMentions('', syms, paths)).toEqual([]);
  });
  it('caps results at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => sym('get_item_' + i));
    expect(rankMentions('get', many, paths)).toHaveLength(20);
  });
  it('scores exact above prefix and breaks ties by shorter label', () => {
    const r = rankMentions('run', [sym('run_all'), sym('run'), sym('run_it')], []);
    expect(r.map(i => i.label)).toEqual(['run', 'run_it', 'run_all']);
  });
  it('matches subsequences with the lowest score', () => {
    const r = rankMentions('gdf', syms, []);
    expect(r.map(i => i.label)).toEqual(['get_debug_flag']);
  });
});

describe('contextMentions', () => {
  it('keeps original anchors when the tool caller strips @ and keeps other hints', () => {
    expect(contextMentions('Inspect @get_debug_flag, then @src/flask/cli.py.', ['get_debug_flag', 'CLI']))
      .toEqual(['@get_debug_flag', '@src/flask/cli.py', 'CLI']);
  });
});
