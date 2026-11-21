/**
 * assembler.test.ts - tests for src/context/search.ts and src/context/assembler.ts (C3).
 *
 * Slice 5: anchors, expansion, packing, graph and assembleContext against an in-memory IndexApi fake with injected ripgrep.
 */
import { describe, expect, it } from 'vitest';
import { bm25Rank, symbolNameMatch, tokenize } from '../src/context/search';
import { assembleContext, buildGraph, expandOneHop, extractAnchors, formatForModel, pack, rrfFuse } from '../src/context/assembler';
import type { Candidate } from '../src/context/assembler';
import { count, previewSelection } from '../src/context/tokens';
import { samplePacket } from '../src/dev/fixtures';
import type { IndexApi } from '../src/context/indexer';
import type { SymbolEntry } from '../src/types';

describe('tokenize', () => {
  it('splits snake_case and camelCase, keeps the whole identifier', () => {
    expect(tokenize('get_debug_flag')).toEqual(['get_debug_flag', 'debug', 'flag']);
    expect(tokenize('FlaskGroup')).toEqual(['flaskgroup', 'flask', 'group']);
  });
  it('drops stopwords and single letters', () => {
    expect(tokenize('add the command to a CLI')).toEqual(['command', 'cli']);
  });
});

describe('bm25Rank', () => {
  it('ranks the matching doc first and omits non-matching docs', () => {
    const r = bm25Rank('routes command', [
      { id: 'a', text: 'def routes_command(): show routes' },
      { id: 'b', text: 'unrelated text about config' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['a']);
  });
});

describe('symbolNameMatch', () => {
  const sym = (name: string): SymbolEntry => ({ id: `p#${name}`, path: 'p', name, qualifiedName: name, kind: 'function', startLine: 1, endLine: 2, decorators: [], calls: [], imports: [], text: '' });
  it('prefers exact over substring', () => {
    const r = symbolNameMatch(['config'], [sym('config_command'), sym('config')]);
    expect(r[0].symbol.name).toBe('config');
  });
});

describe('rrfFuse', () => {
  const c = (id: string): Candidate => ({ id, path: id, startLine: 1, endLine: 2, category: 'impl', text: '', score: 0, reasons: [] });
  it('a candidate in several lists beats one ranked first in a single list', () => {
    const fused = rrfFuse([
      { name: 'a', items: [c('solo'), c('multi')] },
      { name: 'b', items: [c('x'), c('multi')] },
      { name: 'c', items: [c('y'), c('multi')] },
    ]);
    expect(fused[0].id).toBe('multi');
  });
});

describe('formatForModel + count', () => {
  it('formats budget line, headers with reasons and an Omitted list', () => {
    const out = formatForModel(samplePacket);
    expect(out).toContain(`Budget: ${samplePacket.used}/${samplePacket.budget}`);
    expect(out).toContain('### src/flask/cli.py:960-1010 · impl · ');
    expect(out).toContain('≈2100 tokens');
    expect(out).toContain('## Omitted');
    expect(out).toContain('lower-rank');
    expect(out).toContain('over-budget');
    expect(out).toContain('duplicate');
  });
  it('bounds a large selection while preserving small, exact editor text', () => {
    const source = 'line with exact source and <|endoftext|>\n'.repeat(5_000);
    const preview = previewSelection(source);
    expect(preview.truncated).toBe(true);
    expect(source.startsWith(preview.text)).toBe(true);
    expect(count(preview.text)).toBeLessThanOrEqual(1600);
    expect(previewSelection('def example():\n    return 1')).toEqual({ text: 'def example():\n    return 1', truncated: false });
    expect(count('<|endoftext|>')).toBeGreaterThan(1);
  });
  it('count returns a positive integer that grows with text length', () => {
    const n = count('abcdefgh');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(count('abcdefgh '.repeat(50))).toBeGreaterThan(n);
  });
});

// ---------------------------------------------------------------- Slice 5 fixtures

function mk(path: string, name: string, kind: SymbolEntry['kind'], startLine: number, text: string, extra: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    id: `${path}#${name}`, path, name, qualifiedName: name, kind, startLine, endLine: startLine + text.split('\n').length - 1,
    decorators: [], calls: [], imports: [], text, ...extra,
  };
}

function fakeIndex(syms: SymbolEntry[]): IndexApi {
  return {
    ready: Promise.resolve(),
    symbols: () => syms,
    byName: (n) => syms.filter((s) => s.name.toLowerCase() === n.toLowerCase()),
    inFile: (p) => syms.filter((s) => s.path === p),
    enclosing: (p, line) => syms.find((s) => s.path === p && s.startLine <= line && line <= s.endLine),
    reindexFile: async () => {},
    reindexAll: async () => {},
  };
}

const body = (w: string, n: number) => Array.from({ length: n }, (_, i) => `    value_${i} = compute_${w}(${i})  # ${w}`).join('\n');

const SYMS: SymbolEntry[] = [
  mk('src/app/cli.py', 'routes_command', 'function', 10, `@click.command("routes")\ndef routes_command():\n    """Show routes."""\n${body('routes', 6)}`,
    { decorators: ['click.command("routes")'], calls: ['compute_routes'] }),
  mk('src/app/cli.py', 'shell_command', 'function', 40, `@click.command("shell")\ndef shell_command():\n    """Open a shell."""\n${body('shell', 6)}`,
    { decorators: ['click.command("shell")'] }),
  mk('src/app/cli.py', 'AppGroup', 'class', 80, 'class AppGroup:\n    def __init__(self):\n        self.add_command(routes_command)\n        self.add_command(shell_command)',
    { calls: ['add_command'] }),
  mk('src/app/util.py', 'compute_routes', 'function', 1, 'def compute_routes(x):\n    return x'),
  mk('src/app/other.py', 'unrelated', 'function', 1, 'def unrelated():\n    return 1'),
  mk('tests/test_cli.py', 'test_routes_command', 'test', 5, 'def test_routes_command(runner):\n    out = runner.invoke(routes_command)\n    assert "Endpoint" in out', { calls: ['invoke'] }),
  mk('tests/test_cli.py', 'test_other_thing', 'test', 20, 'def test_other_thing():\n    assert unrelated_stuff()'),
  mk('docs/cli.rst', 'Built-in commands', 'doc', 30, 'Built-in commands\n-----------------\nThe routes command shows routes; flask routes lists them.'),
  mk('docs/other.rst', 'Misc', 'doc', 1, 'Misc\n----\nNothing to see.'),
];

const noRg = async () => [];

describe('extractAnchors', () => {
  it('extracts identifiers, quoted strings, constants, CLI phrases; drops stopwords; adds synonyms', () => {
    const { terms } = extractAnchors('Add a new CLI command flask config that masks SECRET and "api_token" using get_debug_flag');
    expect(terms).toContain('config');
    expect(terms).toContain('secret');
    expect(terms).toContain('api_token');
    expect(terms).toContain('get_debug_flag');
    expect(terms).toContain('add_command'); // synonym of command
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('add');
  });
  it('resolves @path and @name mentions as mandatory, and the selection', () => {
    const idx = fakeIndex(SYMS);
    const sel = { path: 'tests/test_cli.py', startLine: 5, endLine: 6, docVersion: 1, hash: 'h', text: 't' };
    const a = extractAnchors('x', ['@src/app/cli.py', '@unrelated'], sel, idx);
    expect(a.mandatory[0].reasons[0].kind).toBe('selection');
    expect(a.mandatory[0].id).toBe('tests/test_cli.py#sel@6');
    expect(a.mandatory[0].text).toBe('t'); // exact editor buffer, not the indexed enclosing function
    expect(a.mandatory.some((c) => c.path === 'src/app/cli.py' && c.reasons.some((r) => r.kind === 'mention'))).toBe(true);
    expect(a.mandatory.some((c) => c.id === 'src/app/other.py#unrelated')).toBe(true);
  });
});

describe('expandOneHop', () => {
  it('names the source in registers / tests / documents reasons', () => {
    const idx = fakeIndex(SYMS);
    const src = SYMS[0];
    const top: Candidate = { id: src.id, path: src.path, startLine: 10, endLine: 20, category: 'impl', text: '', score: 1, reasons: [] };
    const lists = expandOneHop([top], idx, ['routes']);
    const by = Object.fromEntries(lists.map((l) => [l.name, l.items.map((c) => c.id)]));
    expect(by.registers).toContain('src/app/cli.py#shell_command'); // decorator sibling
    expect(by.registers).toContain('src/app/cli.py#AppGroup'); // add_command call site
    expect(by.tests).toContain('tests/test_cli.py#test_routes_command');
    expect(by.documents).toContain('docs/cli.rst#Built-in commands');
    for (const c of lists.flatMap((l) => l.items)) {
      for (const r of c.reasons) expect('from' in r && r.from).toBe('routes_command');
    }
  });
});

describe('pack', () => {
  const cand = (id: string, path: string, s: number, e: number, cat: 'impl' | 'test' | 'docs', score: number, size: number): Candidate => ({
    id, path, startLine: s, endLine: e, category: cat, text: `def ${id.replace(/\W/g, '_')}():\n${'    x = 1\n'.repeat(size)}`, score, reasons: [{ kind: 'lexical', term: 'x', rank: 1 }],
  });
  it('never exceeds the budget and puts mandatory items first', () => {
    const mand = [{ ...cand('m', 'a.py', 1, 5, 'impl', 1, 20), reasons: [{ kind: 'mention' as const, token: '@a' }] }];
    const ranked = Array.from({ length: 30 }, (_, i) => cand(`c${i}`, `f${i}.py`, 1, 5, 'impl', 1 - i / 100, 40));
    for (const budget of [300, 800, 8000]) {
      const r = pack(mand, ranked, budget);
      expect(r.excerpts.reduce((n, e) => n + e.tokens, 0)).toBeLessThanOrEqual(budget);
      expect(r.excerpts[0].id).toBe('m');
    }
  });
  it('reserves the best test and docs candidates even when impl scores higher', () => {
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => cand(`i${i}`, `f${i}.py`, 1, 5, 'impl', 0.5 - i / 100, 30)),
      cand('t', 'tests/test_a.py', 1, 5, 'test', 0.01, 30),
      cand('d', 'docs/a.rst', 1, 5, 'docs', 0.005, 30),
    ];
    const r = pack([], ranked, 500);
    expect(r.excerpts.map((e) => e.category)).toEqual(expect.arrayContaining(['test', 'docs']));
  });
  it('omits overlapping ranges as duplicate, and the rest as lower-rank / over-budget, with tokens', () => {
    const ranked = [
      cand('outer', 'a.py', 1, 50, 'impl', 1, 20),
      cand('inner', 'a.py', 10, 20, 'impl', 0.9, 5),
      cand('huge', 'b.py', 1, 9, 'impl', 0.8, 150),
      ...Array.from({ length: 45 }, (_, i) => cand(`z${i}`, `z${i}.py`, 1, 2, 'impl', 0.79, 1)),
    ];
    const r = pack([], ranked, 300);
    const reasons = new Set(r.omitted.map((o) => o.reason));
    expect(reasons.has('duplicate')).toBe(true);
    expect(reasons.has('over-budget')).toBe(true);
    expect(reasons.has('lower-rank')).toBe(true);
    expect(r.omitted.every((o) => o.tokens > 0)).toBe(true);
  });
  it('trims an oversized symbol to signature + docstring + matching lines', () => {
    const lines = ['@click.command("big")', 'def big_function(a, b):', '    """Docstring here."""',
      ...Array.from({ length: 200 }, (_, i) => (i === 150 ? '    needle_value = 1' : `    filler_${i} = ${i}`))];
    const c: Candidate = { id: 'big', path: 'big.py', startLine: 1, endLine: lines.length, category: 'impl', text: lines.join('\n'), score: 1, reasons: [{ kind: 'lexical', term: 'needle_value', rank: 1 }] };
    const r = pack([], [c], 1000);
    expect(r.excerpts).toHaveLength(1);
    const e = r.excerpts[0];
    expect(e.tokens).toBeLessThanOrEqual(300);
    expect(e.text).toContain('def big_function(a, b):');
    expect(e.text).toContain('Docstring here.');
    expect(e.text).toContain('needle_value');
    expect(e.text).toContain('[trimmed]');
  });
});

describe('assembleContext (in-memory index)', () => {
  it('ranks CLI code, its test and its docs, within budget, with reasons', async () => {
    const p = await assembleContext({ request: 'Add a routes command to the CLI', runId: 'r', budget: 2000, rg: noRg }, fakeIndex(SYMS));
    expect(p.used).toBeLessThanOrEqual(p.budget);
    const ids = p.excerpts.map((e) => e.id);
    expect(ids).toContain('src/app/cli.py#routes_command');
    expect(ids).toContain('tests/test_cli.py#test_routes_command');
    expect(ids).toContain('docs/cli.rst#Built-in commands');
    expect(p.excerpts.every((e) => e.reasons.length > 0)).toBe(true);
  });
  it('uses injected ripgrep hits mapped to enclosing symbols', async () => {
    const rg = async (t: string) => (t === 'unrelated' ? [{ path: 'src/app/other.py', line: 2, preview: 'x' }] : []);
    const p = await assembleContext({ request: 'look at unrelated', runId: 'r', rg }, fakeIndex(SYMS));
    expect(p.excerpts.some((e) => e.id === 'src/app/other.py#unrelated')).toBe(true);
  });
  it('a mention comes first as a mandatory excerpt', async () => {
    const p = await assembleContext({ request: 'explain it', mentions: ['@unrelated'], runId: 'r', rg: noRg }, fakeIndex(SYMS));
    expect(p.excerpts[0].id).toBe('src/app/other.py#unrelated');
    expect(p.excerpts[0].reasons[0]).toEqual({ kind: 'mention', token: '@unrelated' });
  });
  it('graph has labelled edges per reason; heuristic ones are inferred', async () => {
    const p = await assembleContext({ request: 'Add a routes command to the CLI', runId: 'r', budget: 4000, rg: noRg, mentions: ['@shell_command'] }, fakeIndex(SYMS));
    const labels = p.graph.edges.map((e) => e.label);
    expect(labels.some((l) => l.startsWith('lexical:"'))).toBe(true);
    expect(labels).toContain('registers');
    expect(labels).toContain('tests');
    expect(labels).toContain('documents');
    expect(labels.some((l) => l.startsWith('mention'))).toBe(true);
    for (const e of p.graph.edges) if (['registers', 'tests', 'documents'].includes(e.label)) expect(e.inferred).toBe(true);
    expect(p.graph.nodes.some((n) => n.type === 'term')).toBe(true);
    expect(p.graph.nodes.some((n) => n.type === 'file' && n.id === 'file:src/app/cli.py')).toBe(true);
    expect(p.graph.nodes.some((n) => n.type === 'symbol' && n.id.startsWith('sym:src/app/cli.py:'))).toBe(true);
    const ids = new Set(p.graph.nodes.map((n) => n.id));
    expect(p.graph.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });
  it('buildGraph with no excerpts is just the request node', () => {
    expect(buildGraph('q', [], []).nodes).toHaveLength(1);
  });
});
