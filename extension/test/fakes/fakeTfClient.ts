/**
 * fakeTfClient.ts - scripted TfClient for tests. streamTurn yields `turn` events; approve yields the
 * next list from `resumes` (empty if none) and records the call; cancel records and optionally waits
 * on `cancelGate`.
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
  constructor(public turn: TfEvent[] = [], public resumes: TfEvent[][] = []) {}

  async createSession(): Promise<string> { return 'sess_1'; }

  streamTurn(sessionId: string, content: string): AsyncIterable<TfEvent> {
    this.streamCalls.push({ sessionId, content });
    const events = this.turn;
    const hold = this.hold;
    return (async function* () {
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
