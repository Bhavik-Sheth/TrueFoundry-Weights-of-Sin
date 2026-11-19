/**
 * reviewEngine.test.ts - pure decision/result bookkeeping used by ReviewEngine (no vscode).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  acceptedCount, applyEditExact, buildHunks, computeResult, once, rebuildFile, setAllDecisions, setHunkDecision, sha256,
} from '../src/review/proposal';

const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const proposed = applyEditExact(applyEditExact(base, 'line 3\n', 'line 3 changed\n'), 'line 35\n', 'line 35 changed\n');
const mk = () => buildHunks('f.py', base, proposed, sha256(base));

describe('decision bookkeeping', () => {
  it('accepts and rejects individual hunks', () => {
    const hs = mk();
    expect(setHunkDecision(hs, hs[0].id, 'accepted')).toBe(true);
    expect(setHunkDecision(hs, hs[1].id, 'rejected')).toBe(true);
    expect(setHunkDecision(hs, 'nope', 'accepted')).toBe(false);
    expect(acceptedCount(hs)).toBe(1);
    expect(computeResult(hs)).toEqual({ applied: [hs[0].id], rejected: [hs[1].id] });
  });
  it('pending counts as rejected in the result', () => {
    const hs = mk();
    expect(computeResult(hs)).toEqual({ applied: [], rejected: hs.map((h) => h.id) });
  });
  it('accept all / reject all', () => {
    const hs = mk();
    setAllDecisions(hs, 'accepted');
    expect(computeResult(hs).applied).toHaveLength(2);
    setAllDecisions(hs, 'rejected');
    expect(acceptedCount(hs)).toBe(0);
  });
  it('apply with zero accepted leaves base unchanged (reject-all semantics)', () => {
    const hs = mk();
    setAllDecisions(hs, 'rejected');
    expect(acceptedCount(hs)).toBe(0);
    expect(rebuildFile(base, 'f.py', hs)).toBe(base);
    expect(computeResult(hs).applied).toEqual([]);
  });
  it('rebuildFile applies only the accepted hunks of that path', () => {
    const hs = mk();
    setHunkDecision(hs, hs[0].id, 'accepted');
    expect(rebuildFile(base, 'f.py', hs)).toBe(applyEditExact(base, 'line 3\n', 'line 3 changed\n'));
    expect(rebuildFile(base, 'other.py', hs)).toBe(base);
  });
});

describe('once', () => {
  it('calls the resolver at most once', () => {
    const fn = vi.fn();
    const r = once(fn);
    r(true);
    r(false, 'late');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(true);
  });
  it('tolerates an undefined resolver', () => {
    expect(() => once(undefined)(true)).not.toThrow();
  });
});
