/**
 * fakeTfClient.ts - scripted TfClient for tests. streamTurn yields `turn` events (or the per-session
 * script in `scripts`); approve yields the next list from `resumes` (empty if none) and records the
 * call; cancel records and optionally waits on `cancelGate`. Sessions are numbered sess_1, sess_2...
 */
import type { TfClient } from '../../src/run/tfClient';
import type { TfEvent } from '../../src/types';

type Approve = Parameters<TfClient['approve']>[0];

export class FakeTfClient implements TfClient {
  approveCalls: Approve[] = [];
  cancelCalls: string[] = [];
  streamCalls: Array<{ sessionId: string; content: string }> = [];
  cancelGate?: Promise<void>;
  /** If set, the turn stream blocks on this after yielding its events (simulates a live stream). */
  hold?: Promise<void>;
  /** Per-session scripts (override `turn`/`hold`), keyed by session id. `throws` is thrown when the stream opens; a rejecting `hold` throws mid-stream. */
  scripts: Record<string, { events?: TfEvent[]; hold?: Promise<void>; throws?: unknown }> = {};
  /** createSession rejects with this for the given agent name. */
  createFail: Record<string, unknown> = {};
  createdAgents: string[] = [];
  constructor(public turn: TfEvent[] = [], public resumes: TfEvent[][] = []) {}

  async createSession(agent = ''): Promise<string> {
    if (agent in this.createFail) throw this.createFail[agent];
    this.createdAgents.push(agent);
    return `sess_${this.createdAgents.length}`;
  }

  streamTurn(sessionId: string, content: string): AsyncIterable<TfEvent> {
    this.streamCalls.push({ sessionId, content });
    const sc = this.scripts[sessionId];
    const events = sc?.events ?? this.turn;
    const hold = sc ? sc.hold : this.hold;
    const throws = sc?.throws;
    return (async function* () {
      if (throws !== undefined) throw throws;
      for (const e of events) yield e;
      if (hold) await hold;
    })();
  }

  approve(a: Approve): AsyncIterable<TfEvent> {
    this.approveCalls.push(a);
    const events = this.resumes.shift() ?? [];
    return (async function* () { for (const e of events) yield e; })();
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
    await this.cancelGate;
  }

  sessionUrl(id: string): string { return `http://tf/sessions/${id}`; }
  async ping(): Promise<boolean> { return true; }
}
