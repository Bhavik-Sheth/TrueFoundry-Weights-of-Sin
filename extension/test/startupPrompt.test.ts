import { describe, expect, it } from 'vitest';
import { startupPrompt, unfinishedRun } from '../src/run/startupPrompt';
import type { RunRecord, RunEvidence } from '../src/run/journal';

const rec = (sequence: number, evidence: RunEvidence): RunRecord =>
  ({ version: 1, runId: 'r1', sequence, recordedAt: new Date(sequence).toISOString(), evidence });
const request = rec(1, { kind: 'request', mode: 'agent', text: 'fix the bug' });

describe('startupPrompt', () => {
  it('prefers apply over review over unfinished run', () => {
    const unfinished = { runId: 'r1', request: 'x' };
    expect(startupPrompt({ applyPending: true, reviewPending: true, unfinished })).toEqual({
      message: 'Contexo was interrupted while applying reviewed changes.', actions: ['Recover', 'Dismiss'] });
    expect(startupPrompt({ applyPending: false, reviewPending: true, unfinished })).toEqual({
      message: 'Contexo has an unfinished review.', actions: ['Restore Review', 'Dismiss'] });
    expect(startupPrompt({ applyPending: false, reviewPending: false, unfinished: { runId: 'r1', request: 'y'.repeat(80) } })).toEqual({
      message: `A Contexo run did not finish: "${'y'.repeat(60)}".`, actions: ['Resume', 'Dismiss'] });
  });
  it('returns undefined when nothing is pending', () => {
    expect(startupPrompt({ applyPending: false, reviewPending: false })).toBeUndefined();
  });
});

describe('unfinishedRun', () => {
  it('returns the run when last state is streaming or awaiting-review', () => {
    expect(unfinishedRun([request, rec(2, { kind: 'state', state: 'streaming' })]))
      .toEqual({ runId: 'r1', request: 'fix the bug', mode: 'agent' });
    expect(unfinishedRun([request, rec(2, { kind: 'state', state: 'awaiting-review' })])?.runId).toBe('r1');
  });
  it('ignores finished runs and runs without a request', () => {
    expect(unfinishedRun([request, rec(2, { kind: 'state', state: 'streaming' }), rec(3, { kind: 'state', state: 'done' })])).toBeUndefined();
    expect(unfinishedRun([rec(2, { kind: 'state', state: 'streaming' })])).toBeUndefined();
  });
});
