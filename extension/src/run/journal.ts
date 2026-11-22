import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BatchPlan } from './batchPlan';
import { SqliteJournal } from './sqliteJournal';
import type { ContextDelivery, Excerpt, FileContext, Proposal, Run, RunStateMsg, UiStreamEvent } from '../types';

export type RunEvidence =
  | { kind: 'request'; mode: Run['mode']; text: string }
  | { kind: 'session'; agent: string }
  | { kind: 'state'; state: RunStateMsg['state']; detail?: string }
  | { kind: 'agent-event'; event: Exclude<UiStreamEvent, { kind: 'text-delta' }> }
  | { kind: 'tool-output'; toolCallId: string; content: unknown }
  | { kind: 'proposal'; proposal: Pick<Proposal, 'key' | 'toolCallId' | 'hunks' | 'status' | 'result'>; bases: Array<{ path: string; hash: string }>; output?: Array<{ path: string; hash: string }> }
  | { kind: 'batch-plan'; plan: BatchPlan }
  | { kind: 'instruction-pack'; name: string; version: number }
  | { kind: 'hunk-history'; operation: 'undo' | 'redo'; hunkId: string; path: string }
  | { kind: 'check'; source: string; name: string; status: string; proposalKey?: string; hunkIds?: string[]; argv?: string[]; location?: string; startLine?: number; endLine?: number; side?: 'base' | 'candidate'; revision?: string; baseRevision?: string; externalId?: string; sourceUrl?: string; detail?: string; ruleId?: string; fingerprints?: Record<string, string>; startColumn?: number; endColumn?: number }
  | { kind: 'requirement'; requirementId: string; requirementText: string; requirementRevision: number }
  | { kind: 'requirement-link'; requirementId: string; requirementText: string; requirementRevision?: number; proposalKey: string; hunkIds: string[]; checkSequences: number[]; source: 'manual' | 'agent' | 'human'; linked?: boolean }
  | { kind: 'impact'; proposalKey: string; hunkIds: string[]; comparison: unknown }
  | { kind: 'imported'; format: 'native' | 'acp' | 'otlp'; name: string; payload: unknown }
  | { kind: 'context'; packetId: string; contentHash?: string; budget: number; packed: number; delivery: ContextDelivery;
      files?: FileContext[]; excerpts: Array<Pick<Excerpt, 'path' | 'startLine' | 'endLine' | 'category' | 'reasons'>> }
  | { kind: 'review-checkpoint'; proposalKey: string; workspaceUri: string; artifact: string }
  | { kind: 'approval-intent'; toolCallId: string; threadId: string; allow: boolean }
  | { kind: 'reconciliation'; status: string };

export interface RunRecord {
  version: 1;
  runId: string;
  sequence: number;
  recordedAt: string;
  sessionId?: string;
  turnId?: string;
  evidence: RunEvidence;
}

export type RecordEvidence = (runId: string, evidence: RunEvidence, source?: { sessionId?: string; turnId?: string }) => void;

export class RunJournal {
  private readonly sequences = new Map<string, number>();
  private readonly lastObservations = new Map<string, Map<string, string>>();
  private pending = Promise.resolve();
  private failure?: unknown;
  private readonly database: SqliteJournal | undefined;

  constructor(private readonly directory: string, private readonly onError: (error: unknown) => void) {
    this.database = SqliteJournal.supported(directory, onError);
  }

  /** Called synchronously for every evidence record, before it is queued for disk. */
  onRecord?: (runId: string, evidence: RunEvidence) => void;

  readonly record: RecordEvidence = (runId, evidence, source) => {
    this.onRecord?.(runId, evidence);
    const observed = { version: 1 as const, runId, recordedAt: new Date().toISOString(), ...source, evidence };
    // Freeze mutable review objects before waiting on the disk queue.
    const snapshot = JSON.stringify(observed);
    this.pending = this.pending.then(async () => {
      if (this.failure) return;
      const file = this.pathFor(runId);
      if (this.database) {
        await this.database.append(JSON.parse(snapshot) as Omit<RunRecord, 'sequence'>, file);
        return;
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let last = this.sequences.get(runId);
      const observations = this.lastObservations.get(runId) ?? new Map<string, string>();
      const observation = (value: RunEvidence | undefined) => value?.kind === 'check' && value.externalId
        ? { key: value.source + ':' + value.externalId, body: JSON.stringify(value) } : undefined;
      let prefix = '';
      if (last === undefined) {
        const previous = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        last = 0;
        for (const line of previous.trimEnd().split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as Partial<RunRecord>;
            if (record.runId === runId && Number.isSafeInteger(record.sequence)) {
              last = Math.max(last, record.sequence!);
              const item = observation(record.evidence);
              if (item) observations.set(item.key, item.body);
            }
          } catch (error) {
            this.onError(new Error('Unreadable journal record in ' + runId, { cause: error }));
          }
        }
        if (previous && !previous.endsWith('\n')) prefix = '\n';
      }
      const sequence = last + 1;
      const record: RunRecord = { ...JSON.parse(snapshot), sequence };
      this.lastObservations.set(runId, observations);
      const item = observation(record.evidence);
      if (item && observations.get(item.key) === item.body) return;
      const handle = await open(file, 'a', 0o600);
      try {
        await handle.writeFile(prefix + JSON.stringify(record) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequences.set(runId, sequence);
      if (item) observations.set(item.key, item.body);
    }).catch((error: unknown) => {
      this.failure = error;
      this.onError(error);
    });
  };

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }

  async read(runId: string): Promise<string> {
    await this.flush();
    const path = this.pathFor(runId);
    return await this.database?.read(runId) ?? readFile(path, 'utf8');
  }

  async continuationRecords(runId: string): Promise<RunRecord[]> {
    await this.flush();
    const path = this.pathFor(runId);
    const stored = await this.database?.continuationRecords(runId);
    if (stored) return stored;
    const legacy = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const limits: Record<string, number> = { context: 1, proposal: 1, check: 6, 'batch-plan': 1 };
    const selected: RunRecord[] = [];
    for (const line of legacy.trimEnd().split('\n').reverse()) {
      let entry: RunRecord;
      try { entry = JSON.parse(line); } catch { continue; }
      const kind = entry?.evidence?.kind;
      if (entry?.runId !== runId || !Object.hasOwn(limits, kind) || !limits[kind]) continue;
      limits[kind]--;
      selected.push(entry);
      if (selected.length === 9) break;
    }
    return selected;
  }

  async list(): Promise<string[]> {
    await this.flush();
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const portable = files.filter(file => /^[\w-]+\.jsonl$/.test(file)).map(file => file.slice(0, -6));
    return [...new Set([...portable, ...(await this.database?.list() ?? [])])].sort();
  }

  async checkpointReview(proposal: Proposal, workspaceUri: string): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(proposal));
    const artifact = createHash('sha256').update(bytes).digest('hex');
    const directory = join(this.directory, 'artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(directory, artifact));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await this.readArtifact(artifact);
      this.record(proposal.runId, { kind: 'review-checkpoint', proposalKey: proposal.key, workspaceUri, artifact });
      await this.flush();
    } finally {
      await unlink(temporary);
    }
  }

  async readArtifact(digest: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid artifact digest.');
    const bytes = await readFile(join(this.directory, 'artifacts', digest));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Saved artifact digest mismatch.');
    return JSON.parse(bytes.toString('utf8'));
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.database?.close();
    }
  }

  private pathFor(runId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run identifier');
    return join(this.directory, runId + '.jsonl');
  }
}
