import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { contextReceipt, continuation } from '../src/run/continuation';
import { prepareContextForModel } from '../src/context/assembler';
import { RunJournal, type RunRecord } from '../src/run/journal';
import { sha256 } from '../src/review/proposal';
import type { ContextPacket, Proposal, Run } from '../src/types';

const run: Run = {
  id: 'long-run', mode: 'agent', request: 'Migrate the API while preserving existing clients.',
  sessionId: 'fallback', agent: 'contexo-fallback', state: 'streaming', sealedSessions: ['primary'],
};
const key = 'a'.repeat(64);
const proposal: Proposal = {
  key, runId: run.id, toolCallId: 'write', threadId: 'main', status: 'reviewing', files: [],
  hunks: Array.from({ length: 120 }, (_, i) => ({
    id: String(i), path: `packages/module_${i}.py`, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ['-old()', '+new()'], outsideSelection: false,
    decision: i % 3 === 0 ? 'accepted' : i % 3 === 1 ? 'rejected' : 'pending',
  })),
};

test('recovers a source receipt across fallback and journal reopen after many unrelated events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'contexo-continuation-'));
  const journal = new RunJournal(dir, error => { throw error; });
  let reopened: RunJournal | undefined;
  try {
    const packet: ContextPacket = {
      id: 'packet', runId: run.id, query: run.request, budget: 500, used: 9, omitted: [],
      graph: { nodes: [], edges: [] },
      excerpts: [
        { id: 'source', path: 'app.py', startLine: 7, endLine: 9, category: 'impl', text: 'exact source', tokens: 9, score: 1, reasons: [] },
        { id: 'oversized', path: 'large.py', startLine: 1, endLine: 500, category: 'impl', text: 'x'.repeat(24_000), tokens: 9000, score: 1, reasons: [] },
      ],
    };
    const result = prepareContextForModel(packet);
    journal.record(run.id, contextReceipt(packet, result), { sessionId: 'primary', turnId: 'first-turn' });
    journal.record(run.id, { kind: 'proposal', proposal, bases: [] });
    journal.record(run.id, { kind: 'check', name: 'unit', status: 'passed', source: 'fixture', proposalKey: key });
    journal.record('other-run', { kind: 'check', name: 'private', status: 'passed', source: 'fixture' });
    for (let i = 0; i < 150; i++) journal.record(run.id, { kind: 'state', state: 'streaming' });
    await journal.close();
    reopened = new RunJournal(dir, error => { throw error; });
    const records = await reopened.continuationRecords(run.id);
    expect(records).toHaveLength(3);
    const summary = continuation(run, records, { offset: 0 });
    expect(summary).toMatchObject({
      goal: run.request, sessionId: 'fallback',
      lastContext: { packetId: 'packet', journalSequence: 1, turnId: 'first-turn', sha256: sha256(result.text),
        excerpts: [{ path: 'app.py', startLine: 7, endLine: 9, category: 'impl' }], deliveredExcerptCount: 1 },
      proposal: { key, totalFiles: 120, totalHunks: 120, nextOffset: 12 },
      recentChecks: [{ name: 'unit', status: 'passed', proposalKey: key }],
    });
    expect(JSON.stringify(summary)).not.toMatch(/exact source|old\(\)|private|large\.py/);
    expect(JSON.stringify(JSON.stringify(summary)).length).toBeLessThan(22_000);
  } finally {
    await reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('paginates 120 files without losing decisions and rejects a stale proposal key', () => {
  const records: RunRecord[] = [];
  const pages = Array.from({ length: 10 }, (_, i) => continuation(run, records, { offset: 12 * i, proposalKey: key }, proposal));
  const files = pages.flatMap(page => page.proposal?.files ?? []);
  expect(files.map(file => file.path)).toEqual(proposal.hunks.map(hunk => hunk.path));
  expect(files.reduce((n, file) => n + file.accepted, 0)).toBe(40);
  expect(pages[9].proposal?.nextOffset).toBeUndefined();
  expect(continuation(run, records, { offset: 12, proposalKey: 'b'.repeat(64) }, proposal).status).toBe('proposal_changed');
  expect(continuation(run, records, { offset: 0 }, { ...proposal, runId: 'unrelated' }).proposal).toBeUndefined();
});
