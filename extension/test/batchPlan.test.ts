import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { BatchPlans, orderBatches } from '../src/run/batchPlan';
import { RunJournal } from '../src/run/journal';
import { sha256 } from '../src/review/proposal';
import type { Run } from '../src/types';

const batch = (id: string, after: string[] = []) => ({ id, after, goal: id, files: [id + '.py'] });
const makeRun = (): Run => ({ id: randomUUID(), request: 'Migration', mode: 'agent', agent: 'contexo',
  state: 'streaming', sealedSessions: [], sessionId: 'test' });

test('orders prerequisites and rejects cycles, shared paths and traversal', () => {
  expect(orderBatches([batch('consumer', ['contract']), batch('contract')]).map(batch => batch.id))
    .toEqual(['contract', 'consumer']);
  expect(() => orderBatches([batch('a', ['b']), batch('b', ['a'])])).toThrow('cycle');
  expect(() => orderBatches([batch('a'), { ...batch('b'), files: ['a.py'] }])).toThrow('one batch');
  expect(() => orderBatches([{ ...batch('a'), files: ['../a.py'] }])).toThrow('relative');
});

test('requires reviewed revisions and checks, then invalidates completed dependents after a restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'contexo-batches-'));
  const files = new Map([['contract.py', 'original'], ['consumer.py', 'original']]);
  const run = makeRun();
  const active = () => true;
  const command = ['pytest', '-q'];
  const open = () => new RunJournal(folder, error => { throw error; });
  let journal = open();
  const store = () => new BatchPlans(journal, '/workspace', async path => files.get(path));
  const applied = (path: string, text: string) => {
    files.set(path, text);
    const key = sha256(path);
    journal.record(run.id, { kind: 'proposal', bases: [], output: [{ path, hash: sha256(text) }],
      proposal: { key, toolCallId: path, hunks: [], status: 'applied', result: { applied: ['one'], rejected: [] } } });
    return key;
  };
  try {
    const plans = store();
    const initial = await plans.act(run, { action: 'create', offset: 0, batches: [
      batch('consumer', ['contract']), { ...batch('contract'), checks: [command] },
    ] }, active);
    expect(initial.active?.id).toBe('contract');
    await expect(plans.assertScope(run, [{ path: 'consumer.py', baseHash: 'new', newText: 'changed' }])).rejects.toThrow('active batch');
    const first = applied('contract.py', 'contract changed');
    const complete = { action: 'complete' as const, offset: 0, revision: 1, proposalKey: first };
    await expect(plans.act(run, complete, active)).rejects.toThrow('required checks');
    await plans.verify(run, command, async () => ({ exitCode: 0 }), active);
    expect(await plans.act(run, complete, active)).toMatchObject({ revision: 2, active: { id: 'consumer' } });
    const second = applied('consumer.py', 'consumer changed');
    expect(await plans.act(run, { ...complete, revision: 2, proposalKey: second }, active)).toMatchObject({ status: 'complete' });
    await journal.close();
    journal = open();
    files.set('contract.py', 'changed externally');
    const restarted = makeRun();
    expect(await store().act(restarted, { action: 'status', fromRunId: run.id, offset: 0 }, active))
      .toMatchObject({ active: { id: 'contract', files: [{ hash: sha256('changed externally') }] }, invalidated: ['contract', 'consumer'] });
    await expect(new BatchPlans(journal, '/different', async () => undefined).act(makeRun(),
      { action: 'status', fromRunId: run.id, offset: 0 }, active)).rejects.toThrow('in this workspace');
  } finally {
    await journal.close();
    await rm(folder, { recursive: true, force: true });
  }
});
