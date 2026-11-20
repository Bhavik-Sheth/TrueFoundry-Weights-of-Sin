import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
  | { kind: 'check'; source: string; name: string; status: string; proposalKey?: string; hunkIds?: string[]; location?: string }
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
    const sequence = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, sequence);
    const record: RunRecord = { version: 1, runId, sequence, recordedAt: new Date().toISOString(), ...source, evidence };
    // Snapshot at observation time, before an editor action can mutate a hunk.
    const line = JSON.stringify(record) + '\n';
    this.pending = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(join(this.directory, runId + '.jsonl'), line, { encoding: 'utf8', mode: 0o600 });
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
    return readFile(join(this.directory, runId + '.jsonl'), 'utf8');
  }
}
