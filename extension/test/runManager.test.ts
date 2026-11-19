/**
 * runManager.test.ts - RunManager with a scripted fake TfClient and a fake ReviewEngine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/log', () => ({ log: () => {} }));
const killAll = vi.fn();
vi.mock('../src/mcp/runCommand', () => ({ killAll: () => killAll() }));

import { RunManager } from '../src/run/runManager';
import { FakeTfClient } from './fakes/fakeTfClient';
import type { TfEvent, UiStreamEvent } from '../src/types';

const delta = (id: string, content: string): TfEvent => ({ type: 'model.message.delta', id, threadId: 'main', content });
const done: TfEvent = { type: 'turn.done', state: { status: 'done' } };
const paused: TfEvent = { type: 'turn.update', state: { status: 'paused' } };
const created: TfEvent = { type: 'turn.created', turnId: 'turn_1' };
const call = (id: string, name: string, args: unknown): TfEvent => ({
  type: 'model.message', id, threadId: 'main', content: '',
  toolCalls: [{ id: `tc_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const approval = (srcId: string): TfEvent => ({
  type: 'tool.approval_required', id: `ap_${srcId}`, threadId: 'main', toolCalls: [{ id: `tc_${srcId}`, sourceEventId: srcId }],
});

const PROPOSE = { summary: 's', edits: [{ path: 'a.py', baseHash: 'h', oldText: 'x', newText: 'y' }] };

function setup(turn: TfEvent[], resumes: TfEvent[][] = [], begin: () => Promise<'reviewing' | { deny: string }> = async () => 'reviewing') {
  const tf = new FakeTfClient(turn, resumes);
  const order: string[] = [];
  const review = {
    onResolve: undefined as undefined | ((a: boolean, r?: string) => void),
    pending: { hunks: [1, 2] },
    beginProposal: vi.fn(begin),
    discardPending: vi.fn(() => { order.push('discard'); }),
  };
  killAll.mockImplementation(() => { order.push('killAll'); });
  const rm = new RunManager({ tf, review: review as never, cfg: { primaryAgent: 'contexo' } as never });
  const events: UiStreamEvent[] = [];
  const states: Array<{ state: string; hunks?: number }> = [];
  rm.on('stream', (e: UiStreamEvent[]) => events.push(...e));
  rm.on('state', (s) => states.push(s));
  return { tf, review, rm, events, states, order };
}

const text = (events: UiStreamEvent[]) =>
  events.filter((e) => e.kind === 'text-delta').map((e) => (e as { text: string }).text).join('');
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => killAll.mockReset());

describe('RunManager', () => {
  it('merges deltas into one text and finishes done', async () => {
    const { rm, events, states } = setup([created, delta('m1', 'Hel'), delta('m1', 'lo'),
      { type: 'model.message', id: 'm1', threadId: 'main', content: 'Hello', toolCalls: [] }, done]);
    await rm.start('agent', 'hi');
    expect(text(events)).toBe('Hello');
    expect(states.map((s) => s.state)).toEqual(['streaming', 'done']);
  });

  it('ignores events after stop()', async () => {
    let release!: () => void;
    const { rm, tf, events } = setup([created, delta('m1', 'one')]);
    tf.hold = new Promise<void>((r) => { release = r; });
    const p = rm.start('agent', 'hi');
    await tick(); await tick();
    await rm.stop();
    const before = events.length;
    release();
    await p;
    expect(events.length).toBe(before);
    expect(rm.active?.state).toBe('cancelled');
    expect(text(events)).toBe('one');
  });

  it('stop() discards and kills before cancel resolves', async () => {
    let open!: () => void;
    const { rm, tf, order } = setup([created, delta('m1', 'x')]);
    tf.cancelGate = new Promise<void>((r) => { open = r; });
    tf.hold = new Promise<void>(() => {});
    void rm.start('agent', 'hi');
    await tick(); await tick();
    const stopP = rm.stop();
    await tick();
    expect(order).toEqual(['discard', 'killAll']);
    expect(tf.cancelCalls).toEqual(['sess_1']);
    open();
    await stopP;
  });

  it('propose_write: beginProposal gets parsed args; deny sends approve(false, reason)', async () => {
    const { rm, tf, review } = setup(
      [created, call('m1', 'propose_write', PROPOSE), approval('m1'), paused],
      [[done]],
      async () => ({ deny: 'STALE_BASE' }),
    );
    await rm.start('agent', 'edit');
    expect(review.beginProposal).toHaveBeenCalledTimes(1);
    expect((review.beginProposal.mock.calls[0] as unknown[])[3]).toEqual(PROPOSE);
    expect(tf.approveCalls).toHaveLength(1);
    expect(tf.approveCalls[0]).toMatchObject({ allow: false, reason: 'STALE_BASE', toolCallId: 'tc_m1', turnId: 'turn_1' });
    expect(rm.active?.state).toBe('done');
  });

  it('propose_write: awaiting-review with hunk count, then onResolve(true) approves and consumes resume', async () => {
    const { rm, tf, review, states, events } = setup(
      [created, call('m1', 'propose_write', PROPOSE), approval('m1'), paused],
      [[delta('m2', 'applied!'), done]],
    );
    await rm.start('agent', 'edit');
    expect(rm.active?.state).toBe('awaiting-review');
    expect(states.at(-1)).toMatchObject({ state: 'awaiting-review', hunks: 2 });
    expect(tf.approveCalls).toHaveLength(0);
    review.onResolve!(true);
    await tick(); await tick();
    expect(tf.approveCalls[0]).toMatchObject({ allow: true });
    expect(text(events)).toBe('applied!');
    expect(rm.active?.state).toBe('done');
    await expect(rm.start('agent', 'again')).resolves.toBeUndefined();
  });

  it('start() rejects while awaiting review', async () => {
    const { rm } = setup([created, call('m1', 'propose_write', PROPOSE), approval('m1'), paused]);
    await rm.start('agent', 'edit');
    await expect(rm.start('agent', 'x')).rejects.toThrow(/already active/);
  });

  it('run_command is auto-denied', async () => {
    const { rm, tf, review } = setup(
      [created, call('m1', 'run_command', { argv: ['pytest'] }), approval('m1'), paused],
      [[done]],
    );
    await rm.start('agent', 'run');
    expect(review.beginProposal).not.toHaveBeenCalled();
    expect(tf.approveCalls[0]).toMatchObject({ allow: false, reason: 'not implemented until slice 7' });
  });

  it('ignores events of a sealed session', async () => {
    const { rm, tf, events } = setup([created, delta('m1', 'late')]);
    const orig = tf.streamTurn.bind(tf);
    tf.streamTurn = (sid, c) => { rm.active!.sealedSessions.push(sid); return orig(sid, c); };
    await rm.start('agent', 'hi');
    expect(events).toEqual([]);
  });

  it('turn.done error sets failed with an info event', async () => {
    const { rm, events, states } = setup([created, { type: 'turn.done', state: { status: 'error', message: 'boom' } }]);
    await rm.start('agent', 'hi');
    expect(states.at(-1)).toMatchObject({ state: 'failed' });
    expect(events.some((e) => e.kind === 'info' && e.text.includes('boom'))).toBe(true);
  });
});
