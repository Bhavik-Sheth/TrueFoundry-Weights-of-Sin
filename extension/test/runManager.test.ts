/**
 * runManager.test.ts - RunManager with a scripted fake TfClient and a fake ReviewEngine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/log', () => ({ log: () => {} }));
const killAll = vi.fn();
vi.mock('../src/mcp/runCommand', () => ({ killAll: () => killAll() }));

import { RunManager } from '../src/run/runManager';
import type { RunEvidence } from '../src/run/journal';
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

function setup(turn: TfEvent[], resumes: TfEvent[][] = [], begin: () => Promise<'reviewing' | { deny: string }> = async () => 'reviewing', cfgOver: Record<string, unknown> = {}, ask?: (argv: string[]) => Promise<boolean>) {
  const tf = new FakeTfClient(turn, resumes);
  const order: string[] = [];
  const review = {
    onResolve: undefined as undefined | ((a: boolean, r?: string) => void),
    pending: { hunks: [1, 2] },
    beginProposal: vi.fn(begin),
    discardPending: vi.fn(() => { order.push('discard'); }),
  };
  killAll.mockImplementation(async () => { order.push('killAll'); });
  const evidence: RunEvidence[] = [];
  const rm = new RunManager({ tf, review: review as never, cfg: { primaryAgent: 'contexo', fallbackAgent: 'contexo-fallback', firstEventTimeoutMs: 0, trueforgeUrl: 'http://tf:8790', ...cfgOver } as never, askCommandApproval: ask, record: (_id, item) => evidence.push(item) });
  const events: UiStreamEvent[] = [];
  const states: Array<{ state: string; hunks?: number; banner?: string; agent?: string }> = [];
  const sessions: Array<{ sessionId: string; agent: string }> = [];
  rm.on('session', (x) => sessions.push(x));
  rm.on('stream', (e: UiStreamEvent[]) => events.push(...e));
  rm.on('state', (s) => states.push(s));
  return { tf, review, rm, events, states, order, sessions, evidence };
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

  it('reattaches to an existing turn and displays each tool call and text suffix once', async () => {
    const firstCall = call('m1', 'read_file', { path: 'sample.py' });
    const { rm, tf, events } = setup([created, firstCall, delta('m2', 'Hel')]);
    const subscribe = vi.fn(async function* () {
      yield firstCall;
      yield { type: 'model.message', id: 'm2', threadId: 'main', content: 'Hello', toolCalls: [] } as TfEvent;
      yield done;
    });
    Object.assign(tf, { readTurnState: async () => ({ status: 'running' }), subscribeExisting: subscribe });
    await rm.start('agent', 'Continue');
    expect(subscribe).toHaveBeenCalledWith('sess_1', 'turn_1', 'm1', expect.any(AbortSignal));
    expect(text(events)).toBe('Hello');
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(1);
    expect(tf.streamCalls).toHaveLength(1);
    expect(tf.approveCalls).toHaveLength(0);
    expect(rm.active?.state).toBe('done');
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
    const { rm, tf, order, evidence } = setup([created, delta('m1', 'x')]);
    let killed!: () => void;
    killAll.mockImplementationOnce(() => {
      order.push('killAll');
      return new Promise<void>(resolve => { killed = resolve; });
    });
    tf.cancelGate = new Promise<void>((r) => { open = r; });
    tf.hold = new Promise<void>(() => {});
    void rm.start('agent', 'hi');
    await tick(); await tick();
    const stopP = rm.stop();
    await tick();
    expect(order).toEqual(['discard', 'killAll']);
    expect(rm.isToolCallAllowed()).toBe(false);
    expect(evidence.find(item => item.kind === 'metric')).toBeUndefined();
    killed();
    await tick();
    const metric = evidence.find(item => item.kind === 'metric');
    expect(metric).toMatchObject({ kind: 'metric', name: 'stopLatencyMs', value: expect.any(Number) });
    expect(metric?.value).toBeLessThan(300);
    expect(rm.lastStopMs).toBe(metric?.value);
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

  describe('run_command approval', () => {
    const turn = [created, call('m1', 'run_command', { argv: ['pytest', '-q'] }), approval('m1'), paused];

    it('asks and approves on Allow', async () => {
      const ask = vi.fn(async () => true);
      const { rm, tf, review } = setup(turn, [[done]], undefined, {}, ask);
      await rm.start('agent', 'run');
      expect(ask).toHaveBeenCalledWith(['pytest', '-q']);
      expect(review.beginProposal).not.toHaveBeenCalled();
      expect(tf.approveCalls[0]).toMatchObject({ allow: true });
    });

    it('denies with a reason on Deny', async () => {
      const ask = vi.fn(async () => false);
      const { rm, tf } = setup(turn, [[done]], undefined, {}, ask);
      await rm.start('agent', 'run');
      expect(tf.approveCalls[0]).toMatchObject({ allow: false, reason: 'user denied command' });
    });

    it('denies a command outside the allowlist without asking, and says why', async () => {
      const ask = vi.fn(async () => true);
      const gitTurn = [created, call('m1', 'run_command', { input: { argv: ['git', 'show', 'HEAD:a.py'] } }), approval('m1'), paused];
      const { rm, tf } = setup(gitTurn, [[done]], undefined, { commandAllowlist: ['python', 'pytest', 'flask'] }, ask);
      await rm.start('agent', 'run');
      expect(ask).not.toHaveBeenCalled();
      expect(tf.approveCalls[0]).toMatchObject({ allow: false });
      expect(tf.approveCalls[0].reason).toContain('COMMAND_NOT_ALLOWED: git');
    });

    it('denies by default without a handler, and sends one approval only', async () => {
      const { rm, tf } = setup(turn, [[done]]);
      await rm.start('agent', 'run');
      expect(tf.approveCalls).toHaveLength(1);
      expect(tf.approveCalls[0]).toMatchObject({ allow: false });
    });
  });

  it('agent first message carries the workflow hint', async () => {
    const { rm, tf } = setup([created, done]);
    await rm.start('agent', 'add config');
    expect(tf.streamCalls[0].content).toContain('Use assemble_context first');
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

  describe('fallback', () => {
    const errDone = (message: string): TfEvent => ({ type: 'turn.done', state: { status: 'error', message } });

    it('primary turn.done error -> takeOver once, fallback stream consumed, primary events ignored', async () => {
      const { rm, tf, events, states, sessions, review } = setup([]);
      tf.scripts.sess_1 = { events: [created, errDone('Invalid API key for model')] };
      tf.scripts.sess_2 = { events: [created, delta('f1', 'from fallback'), done] };
      await rm.start('agent', 'do it');
      expect(tf.createdAgents).toEqual(['contexo', 'contexo-fallback']);
      expect(tf.streamCalls).toHaveLength(2);
      expect(tf.streamCalls[1].sessionId).toBe('sess_2');
      expect(tf.streamCalls[1].content).toContain('do it');
      expect(tf.streamCalls[1].content).toContain('[Note]');
      expect(review.discardPending).toHaveBeenCalled();
      expect(rm.active?.sealedSessions).toContain('sess_1');
      expect(rm.active?.agent).toBe('contexo-fallback');
      expect(sessions.map((s) => s.agent)).toEqual(['contexo', 'contexo-fallback']);
      expect(text(events)).toBe('from fallback');
      expect(states.some((s) => s.banner?.startsWith('Primary model failed (Invalid API key'))).toBe(true);
      expect(states.at(-1)).toMatchObject({ state: 'done', agent: 'contexo-fallback' });
      expect(states.at(-1)?.banner).toContain('Continued on fallback contexo-fallback');
    });

    it('thrown 401 SDK error during primary streaming triggers fallback', async () => {
      const { rm, tf, states } = setup([]);
      tf.scripts.sess_1 = { throws: Object.assign(new Error('Status code: 401'), { statusCode: 401 }) };
      tf.scripts.sess_2 = { events: [created, done] };
      await rm.start('agent', 'x');
      expect(tf.createdAgents).toHaveLength(2);
      expect(states.at(-1)?.state).toBe('done');
    });

    it('first-event timeout cancels primary and falls back', async () => {
      vi.useFakeTimers();
      try {
        const { rm, tf, states, events } = setup([], [], undefined, { firstEventTimeoutMs: 5000 });
        tf.scripts.sess_1 = { events: [], hold: new Promise<void>(() => {}) };
        tf.scripts.sess_2 = { events: [created, delta('f1', 'ok'), done] };
        const p = rm.start('agent', 'slow');
        await vi.advanceTimersByTimeAsync(4999);
        expect(tf.createdAgents).toEqual(['contexo']);
        await vi.advanceTimersByTimeAsync(2);
        await vi.advanceTimersByTimeAsync(0);
        expect(tf.cancelCalls).toEqual(['sess_1']);
        expect(tf.createdAgents).toEqual(['contexo', 'contexo-fallback']);
        expect(states.some((s) => s.banner?.includes('no response within 5s'))).toBe(true);
        expect(text(events)).toBe('ok');
        expect(rm.active?.state).toBe('done');
        void p;
      } finally {
        vi.useRealTimers();
      }
    });

    it('first event clears the timer (no fallback)', async () => {
      vi.useFakeTimers();
      try {
        const { rm, tf } = setup([created, delta('m1', 'hi')], [], undefined, { firstEventTimeoutMs: 5000 });
        tf.hold = new Promise<void>(() => {});
        void rm.start('agent', 'x');
        await vi.advanceTimersByTimeAsync(10000);
        expect(tf.createdAgents).toEqual(['contexo']);
        expect(tf.cancelCalls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('both fail -> failed with combined message', async () => {
      const { rm, tf, states } = setup([]);
      tf.scripts.sess_1 = { events: [created, errDone('401 Unauthorized')] };
      tf.scripts.sess_2 = { events: [created, errDone('model endpoint refused')] };
      await rm.start('agent', 'x');
      expect(tf.createdAgents).toHaveLength(2);
      const last = states.at(-1)!;
      expect(last.state).toBe('failed');
      expect(last.banner).toBe('Both models failed: 401 Unauthorized; model endpoint refused. No files were changed.');
    });

    it('fallback session creation failure -> combined failure', async () => {
      const { rm, tf, states } = setup([]);
      tf.scripts.sess_1 = { events: [created, errDone('401 Unauthorized')] };
      tf.createFail['contexo-fallback'] = Object.assign(new Error('nf'), { statusCode: 404 });
      await rm.start('agent', 'x');
      expect(states.at(-1)?.banner).toBe('Both models failed: 401 Unauthorized; HTTP 404. No files were changed.');
    });

    it('TrueForge unreachable -> failed, no fallback', async () => {
      const { rm, tf, states } = setup([]);
      tf.createFail.contexo = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      await rm.start('agent', 'x');
      expect(tf.createdAgents).toEqual([]);
      expect(states.at(-1)).toMatchObject({ state: 'failed', banner: 'TrueForge not reachable at http://tf:8790' });
    });

    it('non-model turn error does not fall back', async () => {
      const { rm, tf, states } = setup([created, errDone('boom')]);
      await rm.start('agent', 'x');
      expect(tf.createdAgents).toEqual(['contexo']);
      expect(states.at(-1)).toMatchObject({ state: 'failed', banner: 'boom' });
    });

    it('Stop during primary -> no fallback', async () => {
      let release!: () => void;
      const { rm, tf } = setup([]);
      tf.scripts.sess_1 = { events: [created, delta('m1', 'x')], hold: new Promise<void>((r) => { release = r; }) };
      const p = rm.start('agent', 'x');
      await tick(); await tick();
      await rm.stop();
      release();
      await p;
      expect(tf.createdAgents).toEqual(['contexo']);
      expect(rm.active?.state).toBe('cancelled');
    });

    it('Stop then late primary error -> no fallback', async () => {
      const { rm, tf } = setup([]);
      let fail!: (e: unknown) => void;
      const gate = new Promise<void>((_, rej) => { fail = rej; });
      tf.scripts.sess_1 = { events: [created], hold: gate };
      const p = rm.start('agent', 'x');
      await tick(); await tick();
      await rm.stop();
      fail(Object.assign(new Error('x'), { statusCode: 500 }));
      await p;
      expect(tf.createdAgents).toEqual(['contexo']);
    });
  });
});

describe('pending review recovery', () => {
  function recoverySetup() {
    const { tf, review, rm } = setup([]);
    const attach = vi.fn(async () => {});
    Object.assign(review, { attachProposal: attach });
    const reconcile = vi.fn(async () => 'saved-cursor');
    Object.assign(tf, { resumeReview: reconcile });
    const run = {
      id: 'saved-run', mode: 'agent', request: 'Fix the review', sessionId: 'saved-session',
      agent: 'contexo', state: 'awaiting-review', sealedSessions: [],
    } as const;
    const checkpoint = {
      run: { ...run, sealedSessions: [] },
      turnId: 'saved-turn', runtime: 'http://tf:8790', root: 'file:///workspace',
      proposal: {
        key: 'abcd', runId: run.id, toolCallId: 'saved-call', threadId: 'main',
        status: 'reviewing', files: [], hunks: [{
          id: 'h1', path: 'sample.py', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          decision: 'accepted', outsideSelection: false, lines: ['-old', '+new'],
        }],
      },
    } satisfies import('../src/run/reviewCheckpoint').ReviewCheckpoint;
    return { rm, attach, reconcile, checkpoint };
  }

  it('reopens the same proposal and decisions after the server confirms the approval', async () => {
    const { rm, attach, reconcile, checkpoint } = recoverySetup();
    await rm.restoreReview(checkpoint);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'saved-session' }), 'saved-turn', 'saved-call', 'main');
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-run' }), checkpoint.proposal);
    expect(rm.active?.state).toBe('awaiting-review');
    await rm.confirmReview(checkpoint.proposal);
    expect(reconcile).toHaveBeenLastCalledWith(rm.active, 'saved-turn', 'saved-call', 'main', false);
  });

  it('leaves the saved review closed when the server cannot confirm the approval', async () => {
    const { rm, attach, reconcile, checkpoint } = recoverySetup();
    reconcile.mockRejectedValueOnce(new Error('TrueForge turn is cancelled.'));
    await expect(rm.restoreReview(checkpoint)).rejects.toThrow('TrueForge turn is cancelled.');
    expect(attach).not.toHaveBeenCalled();
    expect(rm.active).toBeUndefined();
  });
});
