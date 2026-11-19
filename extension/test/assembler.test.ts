/**
 * assembler.test.ts - tests for src/context/search.ts and src/context/assembler.ts (C3).
 *
 * Real in S0: tokenize, bm25Rank, symbolNameMatch, rrfFuse, formatForModel, assembleContext stub shape.
 * Slice 5 behaviour is listed as it.todo.
 */
import { describe, expect, it } from 'vitest';
import { bm25Rank, symbolNameMatch, tokenize } from '../src/context/search';
import { assembleContext, formatForModel, rrfFuse } from '../src/context/assembler';
import type { Candidate } from '../src/context/assembler';
import { count } from '../src/context/tokens';
import { samplePacket } from '../src/dev/fixtures';
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

describe('assembleContext stub + formatForModel', () => {
  it('returns the sample packet shape', async () => {
    const idx = { ready: Promise.resolve(), symbols: () => [], byName: () => [], inFile: () => [], enclosing: () => undefined, reindexFile: async () => {}, reindexAll: async () => {} };
    const p = await assembleContext({ request: 'x', runId: 'r1' }, idx);
    expect(p.runId).toBe('r1');
    expect(p.excerpts.length).toBeGreaterThan(0);
  });
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
  it('count is a chars/4 estimate', () => {
    expect(count('abcdefgh')).toBe(2);
  });
});

describe('slice 5 behaviour', () => {
  it.todo('RRF ordering on hand-made lists through assembleContext');
  it.todo('budget respected at 8k and small budgets; mandatory items first');
  it.todo('coverage quota reserves one test and one docs excerpt');
  it.todo('omissions carry reasons (duplicate | lower-rank | over-budget) and tokens');
  it.todo('oversized symbol (> 30% of budget) trimmed to signature + docstring + matching lines');
  it.todo('anchor extraction: identifiers, quoted strings, CLI words, constants, stopwords dropped');
  it.todo('expansion reasons name their source (registers / tests / documents)');
  it.todo('graph has labelled edges for each reason; latency < 1 s on a Flask-sized fixture');
});
