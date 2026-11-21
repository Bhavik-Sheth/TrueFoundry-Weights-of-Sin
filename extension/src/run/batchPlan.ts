import { z } from 'zod';
import type { Proposal, ProposeArgs, Run } from '../types';
import type { RunJournal } from './journal';
import { rebuildFile, sha256 } from '../review/proposal';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/);
const revision = z.number().int().positive();
const batchInput = z.object({
  id,
  goal: z.string().trim().min(1).max(240),
  files: z.array(z.string().min(1).max(240)).min(1).max(8),
  after: z.array(id).max(8),
  checks: z.array(z.array(z.string().min(1).max(200)).min(1).max(10)).max(2).optional(),
});
export const batchPlanInput = {
  action: z.enum(['create', 'status', 'complete']),
  batches: z.array(batchInput).min(1).max(40).optional(),
  revision: revision.optional().describe('Revision from the previous batch_plan response'),
  proposalKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  fromRunId: z.string().uuid().optional().describe('Explicitly restore a plan from another run in this workspace'),
  offset: z.number().int().min(0).max(40).default(0),
};

type Batch = z.infer<typeof batchInput>;
type Input = z.infer<z.ZodObject<typeof batchPlanInput>>;
type FileRevision = { path: string; hash: string };

export interface BatchPlan {
  workspace: string;
  goal: string;
  revision: number;
  batches: Array<Batch & { complete?: { output: FileRevision[]; proposalKey: string } }>;
}

export function orderBatches(batches: Batch[]): Batch[] {
  const ids = new Set(batches.map(batch => batch.id));
  if (ids.size !== batches.length || batches.some(batch => batch.after.some(parent => !ids.has(parent)))) {
    throw new Error('Use unique batch IDs and declare only dependencies in this plan.');
  }
  const files = batches.flatMap(batch => batch.files);
  if (new Set(files).size !== files.length || files.length > 160) {
    throw new Error('Assign each file to one batch and use at most 160 files per plan.');
  }
  for (const file of files) {
    if (/[\\:\x00-\x1f\x7f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Use normalized workspace-relative plan paths.');
    }
  }
  const emitted = new Set<string>();
  const pending = [...batches];
  const ordered: Batch[] = [];
  while (pending.length) {
    const position = pending.findIndex(batch => batch.after.every(parent => emitted.has(parent)));
    if (position < 0) throw new Error('Batch dependencies contain a cycle.');
    const [next] = pending.splice(position, 1);
    ordered.push(next);
    emitted.add(next.id);
  }
  return ordered;
}

export function proposalOutput(proposal: Proposal): FileRevision[] {
  return proposal.files.flatMap(file => {
    const text = rebuildFile(file.base, file.path, proposal.hunks);
    return text === file.base ? [] : [{ path: file.path, hash: sha256(text) }];
  });
}

/** One writer per active run. Read-back always uses the journal, including on restore. */
export class BatchPlans {
  private queue = Promise.resolve();

  constructor(private journal: RunJournal, private workspace: string,
    private read: (path: string) => Promise<string | undefined>) {}

  private async snapshot(paths: string[]): Promise<FileRevision[]> {
    const revisions: FileRevision[] = [];
    for (const path of paths) {
      const text = await this.read(path);
      revisions.push({ path, hash: text === undefined ? 'new' : sha256(text) });
    }
    return revisions;
  }

  private async reconcile(plan: BatchPlan) {
    const invalidated = new Set<string>();
    for (const batch of plan.batches) {
      if (!batch.complete) continue;
      const changed = batch.after.some(id => invalidated.has(id)) ||
        (await this.snapshot(batch.files)).some((file, i) => batch.complete!.output[i]?.hash !== file.hash);
      if (changed) {
        delete batch.complete;
        invalidated.add(batch.id);
      }
    }
    if (invalidated.size) plan.revision++;
    return [...invalidated];
  }

  private async latest(runId: string) {
    const records = await this.journal.continuationRecords(runId);
    const evidence = records.find(record => record.evidence.kind === 'batch-plan')?.evidence;
    return evidence?.kind === 'batch-plan' ? evidence : undefined;
  }

  async assertScope(run: Run, edits: ProposeArgs['edits']) {
    const plan = (await this.latest(run.id))?.plan;
    if (!plan) return;
    if ((await this.reconcile(plan)).length) throw new Error('Refresh batch_plan before editing because completed files changed.');
    const batch = plan.batches.find(batch => !batch.complete);
    if (!batch || edits.some(edit => !batch.files.includes(edit.path))) {
      throw new Error('The proposal must stay within the active batch.');
    }
  }

  async verify<T extends { exitCode: number }>(run: Run, argv: string[], execute: () => Promise<T>, active: () => boolean) {
    const records = await this.journal.continuationRecords(run.id);
    const plan = records.find(record => record.evidence.kind === 'batch-plan')?.evidence;
    const expected = plan?.kind === 'batch-plan' && plan.plan.batches.find(batch => !batch.complete)?.checks;
    const command = JSON.stringify(argv);
    const proposal = records.find(record => record.evidence.kind === 'proposal')?.evidence;
    if (!expected || !expected.some(check => JSON.stringify(check) === command) ||
        proposal?.kind !== 'proposal' || proposal.proposal.status !== 'applied' || !proposal.output?.length) return execute();

    const matches = async () => (await this.snapshot(proposal.output!.map(file => file.path)))
      .every((file, i) => file.hash === proposal.output![i].hash);
    const before = await matches();
    if (!active()) throw new Error('The run no longer owns this session.');
    const result = await execute();
    if (before && result.exitCode === 0 && await matches() && active()) {
      this.journal.record(run.id, { kind: 'check', source: 'batch command', name: argv[0],
        status: 'passed', proposalKey: proposal.proposal.key, argv }, { sessionId: run.sessionId });
      await this.journal.flush();
    }
    return result;
  }

  act(run: Run, args: Input, active: () => boolean) {
    const operation = this.queue.then(() => this.update(run, args, active));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async update(run: Run, args: Input, active: () => boolean) {
    const current = (await this.latest(run.id))?.plan;
    let plan = current;
    if (args.action === 'create') {
      if (current || !args.batches || args.fromRunId) throw new Error('Create a plan once per run.');
      plan = { workspace: this.workspace, goal: run.request.slice(0, 1250), revision: 1, batches: orderBatches(args.batches) };
    } else if (args.fromRunId) {
      if (current || args.action !== 'status') throw new Error('Restore a previous plan before creating or completing a batch.');
      plan = (await this.latest(args.fromRunId))?.plan;
      if (!plan || plan.workspace !== this.workspace) throw new Error('No batch plan for that run in this workspace.');
      plan.revision++;
    }
    if (!plan) return { status: 'no_plan' };
    if (plan.workspace !== this.workspace) throw new Error('This plan belongs to another workspace.');
    const originalRevision = plan.revision;
    const invalidated = await this.reconcile(plan);
    const activeBatch = plan.batches.find(batch => !batch.complete);
    let status = 'ready';
    if (args.action === 'complete') {
      if (args.revision !== plan.revision) {
        status = 'revision_changed';
      } else {
        if (!activeBatch || !args.proposalKey) throw new Error('Supply the current batch revision and an applied proposal key.');
        const records = await this.journal.continuationRecords(run.id);
        const evidence = records.find(record => record.evidence.kind === 'proposal')?.evidence;
        if (evidence?.kind !== 'proposal' || evidence.proposal.key !== args.proposalKey ||
            evidence.proposal.status !== 'applied' || evidence.proposal.result?.rejected.length ||
            !evidence.output || evidence.output.length !== activeBatch.files.length) {
          throw new Error('Complete the active batch with its latest fully applied proposal.');
        }
        const checks = new Set(records.flatMap(({ evidence }) => evidence.kind === 'check' &&
          evidence.source === 'batch command' && evidence.status === 'passed' && evidence.proposalKey === args.proposalKey
          ? [JSON.stringify(evidence.argv)] : []));
        if (activeBatch.checks?.some(argv => !checks.has(JSON.stringify(argv)))) {
          throw new Error('Run the batch’s required checks successfully before completing it.');
        }
        const output = new Map(evidence.output.map(file => [file.path, file.hash]));
        const live = await this.snapshot(activeBatch.files);
        if (live.some(file => output.get(file.path) !== file.hash)) throw new Error('The reviewed changes do not match current batch files.');
        activeBatch.complete = { output: live, proposalKey: args.proposalKey };
        plan.revision++;
      }
    }
    const next = plan.batches.find(batch => !batch.complete);
    const files = next ? await this.snapshot(next.files) : undefined;
    if (!active()) throw new Error('The run no longer owns this session.');
    if (!current || plan.revision !== originalRevision) {
      this.journal.record(run.id, { kind: 'batch-plan', plan }, { sessionId: run.sessionId });
      await this.journal.flush();
    }
    return {
      status: status === 'ready' && !next ? 'complete' : status,
      runId: run.id, revision: plan.revision, goal: plan.goal, invalidated,
      active: next && { id: next.id, goal: next.goal, files, checks: next.checks },
      batches: plan.batches.slice(args.offset, args.offset + 6).map(({ id, after, complete }) => ({ id, after, complete: !!complete })),
      nextOffset: args.offset + 6 < plan.batches.length ? args.offset + 6 : undefined,
    };
  }
}
