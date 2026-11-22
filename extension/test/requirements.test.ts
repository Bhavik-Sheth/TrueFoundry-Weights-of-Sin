/**
 * requirements.test.ts - tests for src/review/requirements.ts (splitting and evidence-derived state).
 */
import { describe, expect, it } from 'vitest';
import type { RunEvidence, RunRecord } from '../src/run/journal';
import { reduceRequirements, resolveRequirementRefs, splitRequirements } from '../src/review/requirements';

const B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

describe('splitRequirements', () => {
  it('splits sentences and clause openers', () => {
    expect(splitRequirements(B)).toEqual([
      "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON",
      'masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***"',
      'It must appear in flask --help',
      'be covered by a test',
      'be documented alongside the other built-in commands',
    ]);
  });
  it('returns the trimmed request when nothing splits', () => {
    expect(splitRequirements('Rename foo to bar')).toEqual(['Rename foo to bar']);
  });
});

const rec = (evidence: RunEvidence, sequence: number): RunRecord => ({ version: 1, runId: 'r', sequence, recordedAt: '', evidence });
const hunk = (decision: 'pending' | 'accepted') => ({ id: 'h1', path: 'a.py', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [], decision }) as any;
const proposal = (status: 'reviewing' | 'applied', decision: 'pending' | 'accepted', applied: string[] = []): RunEvidence =>
  ({ kind: 'proposal', proposal: { key: 'k', toolCallId: 't', hunks: [hunk(decision)], status, result: status === 'applied' ? { applied, rejected: [] } : undefined }, bases: [] });
const call: RunEvidence = { kind: 'agent-event', event: { kind: 'tool-call', toolCallId: 'c1', name: 'run_command', args: { argv: ['pytest'] } } };
const output: RunEvidence = { kind: 'tool-output', toolCallId: 'c1', content: JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }) };
const requirement = rec({ kind: 'requirement', requirementId: 'q1', requirementText: 'Do it', requirementRevision: 1 }, 1);
const link = (sequence: number, extra: object = {}) => rec({
  kind: 'requirement-link', requirementId: 'q1', requirementText: 'Do it', proposalKey: 'k', hunkIds: ['h1'], checkSequences: [], source: 'agent', ...extra,
} as RunEvidence, sequence);

describe('reduceRequirements', () => {
  it('is open without links', () => {
    expect(reduceRequirements([requirement])[0]).toMatchObject({ label: 'R1', state: 'open', links: [] });
  });
  it('state climbs to checked only after apply then exit 0', () => {
    const records = [requirement, link(2), rec(proposal('reviewing', 'accepted'), 3), rec(proposal('applied', 'accepted', ['h1']), 4), rec(call, 5), rec(output, 6)];
    expect(reduceRequirements(records.slice(0, 2))[0].state).toBe('proposed');
    expect(reduceRequirements(records.slice(0, 3))[0].state).toBe('accepted');
    expect(reduceRequirements(records.slice(0, 4))[0].state).toBe('applied');
    expect(reduceRequirements(records)[0]).toMatchObject({ label: 'R1', state: 'checked', links: [{ hunkId: 'h1', source: 'agent' }] });
  });
  it('a check before apply does not count', () => {
    const records = [requirement, link(2), rec(call, 3), rec(output, 4), rec(proposal('applied', 'accepted', ['h1']), 5)];
    expect(reduceRequirements(records)[0].state).toBe('applied');
  });
  it('a human toggle-off removes the link, and manual counts as human', () => {
    const on = link(2, { source: 'manual' });
    expect(reduceRequirements([requirement, on])[0].links).toEqual([{ hunkId: 'h1', source: 'human' }]);
    expect(reduceRequirements([requirement, on, link(3, { source: 'human', linked: false })])[0]).toMatchObject({ state: 'open', links: [] });
  });
  it('latest revision wins', () => {
    const edited = rec({ kind: 'requirement', requirementId: 'q1', requirementText: 'Do it better', requirementRevision: 2 }, 2);
    expect(reduceRequirements([requirement, edited])[0]).toMatchObject({ text: 'Do it better', revision: 2 });
  });
});

describe('resolveRequirementRefs', () => {
  it('resolves labels and case-insensitive text, ignoring unknowns', () => {
    const reqs = [{ id: 'a', text: 'First one' }, { id: 'b', text: 'Second' }];
    expect(resolveRequirementRefs(['R2', 'first ONE', 'R9', 'nope'], reqs)).toEqual(['b', 'a']);
  });
});
