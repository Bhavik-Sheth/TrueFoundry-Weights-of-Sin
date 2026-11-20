import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Proposal, Run, RunStateMsg, UiStreamEvent } from '../types';

export type RunEvidence =
  | { kind: 'request'; mode: Run['mode']; text: string }
  | { kind: 'session'; agent: string }
  | { kind: 'state'; state: RunStateMsg['state']; detail?: string }
  | { kind: 'agent-event'; event: Exclude<UiStreamEvent, { kind: 'text-delta' }> }
  | { kind: 'tool-output'; toolCallId: string; content: unknown }
  | { kind: 'proposal'; proposal: Pick<Proposal, 'key' | 'toolCallId' | 'hunks' | 'status' | 'result'>; bases: Array<{ path: string; hash: string }> }
  | { kind: 'hunk-history'; operation: 'undo' | 'redo'; hunkId: string; path: string }
  | { kind: 'check'; source: string; name: string; status: string; proposalKey?: string; hunkIds?: string[]; location?: string; startLine?: number; endLine?: number; side?: 'base' | 'candidate'; revision?: string; baseRevision?: string; externalId?: string; sourceUrl?: string; detail?: string }
  | { kind: 'requirement-link'; requirementId: string; requirementText: string; proposalKey: string; hunkIds: string[]; checkSequences: number[]; source: 'manual' }
  | { kind: 'impact'; proposalKey: string; hunkIds: string[]; comparison: unknown }
  | { kind: 'imported'; format: 'native' | 'acp' | 'otlp'; name: string; payload: unknown }
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
  private pending = Promise.resolve();
  private failure?: unknown;

  constructor(private readonly directory: string, private readonly onError: (error: unknown) => void) {}

  readonly record: RecordEvidence = (runId, evidence, source) => {
    const observed = { version: 1 as const, runId, recordedAt: new Date().toISOString(), ...source, evidence };
    // Freeze mutable review objects before waiting on the disk queue.
    const snapshot = JSON.stringify(observed);
    this.pending = this.pending.then(async () => {
      if (this.failure) return;
      const file = this.pathFor(runId);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let last = this.sequences.get(runId);
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
            }
          } catch (error) {
            this.onError(new Error('Unreadable journal record in ' + runId, { cause: error }));
          }
        }
        if (previous && !previous.endsWith('\n')) prefix = '\n';
      }
      const sequence = last + 1;
      const record: RunRecord = { ...JSON.parse(snapshot), sequence };
      const handle = await open(file, 'a', 0o600);
      try {
        await handle.writeFile(prefix + JSON.stringify(record) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequences.set(runId, sequence);
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
    return readFile(this.pathFor(runId), 'utf8');
  }

  private pathFor(runId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid run identifier');
    return join(this.directory, runId + '.jsonl');
  }
}
