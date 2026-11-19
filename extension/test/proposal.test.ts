/**
 * proposal.test.ts - tests for src/review/proposal.ts (C4, pure).
 *
 * Covers: exact single match; not found / ambiguous / create; CRLF preserved; hunk ids stable;
 * rebuildFromAccepted with all, none and the first of two hunks; proposalKey independent of key order.
 * Stale-base and undo round-trips belong to diffView / applyUndo (Slices 3-4): see it.todo.
 */
import { describe, expect, it } from 'vitest';
import { applyEditExact, buildHunks, canonicalJson, proposalKey, rebuildFromAccepted, sha256 } from '../src/review/proposal';

const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('applyEditExact', () => {
  it('replaces a single exact match', () => {
    expect(applyEditExact('a\nb\nc\n', 'b', 'B')).toBe('a\nB\nc\n');
  });
  it('throws OLD_TEXT_NOT_FOUND', () => {
    expect(() => applyEditExact('a\nb\n', 'zzz', 'x')).toThrow(/OLD_TEXT_NOT_FOUND/);
  });
  it('throws AMBIGUOUS_MATCH', () => {
    expect(() => applyEditExact('x\nx\n', 'x', 'y')).toThrow(/AMBIGUOUS_MATCH/);
  });
  it('creates when oldText is empty and base is empty', () => {
    expect(applyEditExact('', '', 'new file\n')).toBe('new file\n');
  });
  it('refuses create over existing content', () => {
    expect(() => applyEditExact('exists', '', 'x')).toThrow();
  });
  it('preserves CRLF', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    expect(applyEditExact(crlf, 'b\nc', 'B\nC\nD')).toBe('a\r\nB\r\nC\r\nD\r\n');
  });
});

describe('proposalKey', () => {
  it('is independent of key order', () => {
    const a = { summary: 's', edits: [{ path: 'p', baseHash: 'h', oldText: 'o', newText: 'n' }] };
    const b = { edits: [{ newText: 'n', oldText: 'o', baseHash: 'h', path: 'p' }], summary: 's' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(proposalKey(a)).toBe(proposalKey(b));
  });
  it('changes when an edit changes', () => {
    expect(proposalKey({ a: 1 })).not.toBe(proposalKey({ a: 2 }));
  });
});

describe('buildHunks / rebuildFromAccepted', () => {
  const proposed = applyEditExact(applyEditExact(base, 'line 3\n', 'line 3 changed\n'), 'line 35\n', 'line 35 changed\n');
  const hash = sha256(base);

  it('produces two hunks with stable ids and 3 lines of context', () => {
    const h1 = buildHunks('f.py', base, proposed, hash);
    const h2 = buildHunks('f.py', base, proposed, hash);
    expect(h1).toHaveLength(2);
    expect(h1.map((h) => h.id)).toEqual(h2.map((h) => h.id));
    expect(new Set(h1.map((h) => h.id)).size).toBe(2);
    expect(h1[0].id).toHaveLength(12);
    expect(h1[0].decision).toBe('pending');
    // first hunk starts at line 1 (change on line 3, 3 context lines after)
    expect(h1[1].lines.filter((l) => l.startsWith(' ')).length).toBeGreaterThanOrEqual(6);
  });

  it('rebuilds with all hunks accepted', () => {
    const hs = buildHunks('f.py', base, proposed, hash).map((h) => ({ ...h, decision: 'accepted' as const }));
    expect(rebuildFromAccepted(base, hs)).toBe(proposed);
  });

  it('rebuilds with none accepted', () => {
    const hs = buildHunks('f.py', base, proposed, hash);
    expect(rebuildFromAccepted(base, hs)).toBe(base);
  });

  it('rebuilds with only the first of two accepted', () => {
    const hs = buildHunks('f.py', base, proposed, hash).map((h, i) => ({ ...h, decision: i === 0 ? ('accepted' as const) : ('rejected' as const) }));
    expect(rebuildFromAccepted(base, hs)).toBe(applyEditExact(base, 'line 3\n', 'line 3 changed\n'));
  });

  it('rebuilds with only the second of two accepted', () => {
    const hs = buildHunks('f.py', base, proposed, hash).map((h, i) => ({ ...h, decision: i === 1 ? ('accepted' as const) : ('rejected' as const) }));
    expect(rebuildFromAccepted(base, hs)).toBe(applyEditExact(base, 'line 35\n', 'line 35 changed\n'));
  });

  it('throws REBUILD_FAILED when the base no longer matches', () => {
    const hs = buildHunks('f.py', base, proposed, hash).map((h) => ({ ...h, decision: 'accepted' as const }));
    expect(() => rebuildFromAccepted('totally different\n', hs)).toThrow(/REBUILD_FAILED/);
  });

  it('works with CRLF content', () => {
    const b = 'a\r\nb\r\nc\r\n';
    const p = applyEditExact(b, 'b', 'B');
    expect(p).toBe('a\r\nB\r\nc\r\n');
    const hs = buildHunks('f.py', b, p, sha256(b)).map((h) => ({ ...h, decision: 'accepted' as const }));
    expect(rebuildFromAccepted(b, hs)).toBe(p);
  });
});

describe('later slices', () => {
  it.todo('STALE_BASE auto-deny in ReviewEngine.beginProposal (Slice 3)');
  it.todo('undo/redo patch round-trip; undo refuses when text changed at the hunk (Slice 4)');
});
