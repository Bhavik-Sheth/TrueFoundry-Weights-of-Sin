/**
 * run/runManager.ts - C2 owner of the single active Run. (Slice 0: minimal but real.)
 *
 * Exports:
 *  - class RunManager extends EventEmitter. Events: 'state'(RunStateMsg), 'stream'(UiStreamEvent[]),
 *    'session'({sessionId, agent, url}).
 *    - start(mode, text, selection?): create session on cfg.primaryAgent, build first message
 *      (inline: path/lines/baseHash/selected text template; agent: the text), consume() the turn.
 *    - send(text): follow-up turn on the same session (starts a new agent run if none usable).
 *    - consume(): loops over the turn stream, tracks turnId (turn.created) and lastEventId, maps
 *      events to UiStreamEvent, ignores events once cancelled / sealed.
 *    - tool.approval_required: Slice 0 = AUTO-DENY with "not implemented in base" through
 *      resolveApproval(false, ...) after the stream pauses (S1/S3 replace this with the review flow).
 *    - resolveApproval(allow, reason?): approve() resumed stream (subscribeToTurn + user.tool_approval).
 *    - stop(): synchronous first (state='cancelled', abort stream, review.discardPending()), then
 *      await tf.cancel(). Late events are ignored.
 *    - isToolCallAllowed(): false only while the active run is cancelled (MCP tools check this).
 *
 * Not yet (later slices): fallback (S8), real approvals (S1/S3/S7), runCommand.killAll.
 * Rules: one active run only; never writes to disk.
 * Depends on: types, config, run/tfClient, review/diffView, log. Depended on by: extension, mcp/tools, shell/inlineEdit.
 */
import { EventEmitter } from 'node:events';
import type { ContexoConfig } from '../config';
import type { ReviewEngine } from '../review/diffView';
import type { Run, RunStateMsg, Selection, TfEvent, UiStreamEvent } from '../types';
import type { TfClient } from './tfClient';
import { log } from '../log';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = { type: string; id?: string; [k: string]: any };

interface PendingApproval { threadId: string; toolCallId: string; name: string }

export class RunManager extends EventEmitter {
  active?: Run;

  private tf: TfClient;
  private review: ReviewEngine;
  private cfg: ContexoConfig;
  private runCounter = 0;
  private turnId = '';
  private lastEventId = '';
  private abort?: AbortController;
  private pending: PendingApproval[] = [];
  private messages = new Map<string, Ev>();        // model.message events by id (tool-call lookup)
  private streamedIds = new Set<string>();         // message ids that already produced text-deltas

  constructor(deps: { tf: TfClient; review: ReviewEngine; cfg: ContexoConfig }) {
    super();
    this.tf = deps.tf;
    this.review = deps.review;
    this.cfg = deps.cfg;
  }

  async start(mode: 'inline' | 'agent', text: string, selection?: Selection): Promise<void> {
    const cur = this.active;
    if (cur && (cur.state === 'streaming' || cur.state === 'awaiting-review')) {
      throw new Error('A Contexo run is already active. Stop it first.');
    }
    const agent = this.cfg.primaryAgent;
    const run: Run = {
      id: `run_${++this.runCounter}`, mode, request: text, selection,
      sessionId: '', agent: agent as Run['agent'], state: 'streaming', sealedSessions: [],
    };
    this.active = run;
    this.pending = [];
    this.messages.clear();
    this.streamedIds.clear();
    this.turnId = '';
    this.lastEventId = '';
    this.setState('streaming');
    try {
      run.sessionId = await this.tf.createSession(agent);
    } catch (e) {
      this.fail(run, `Could not create a TrueForge session: ${String(e)}`);
      return;
    }
    if (run.state === 'cancelled') return;
    this.emit('session', { sessionId: run.sessionId, agent, url: this.tf.sessionUrl(run.sessionId) });
    log('run.start', run.id, mode, run.sessionId);
    await this.runTurn(run, buildFirstMessage(mode, text, selection));
  }

  async send(text: string): Promise<void> {
    const run = this.active;
    if (!run || run.state === 'cancelled' || run.state === 'failed') {
      return this.start('agent', text);
    }
    if (run.state === 'streaming' || run.state === 'awaiting-review') {
      this.emit('stream', [{ kind: 'info', text: 'A turn is still running. Stop it before sending another message.' }] as UiStreamEvent[]);
      return;
    }
    run.state = 'streaming';
    this.setState('streaming');
    await this.runTurn(run, text);
  }

  async stop(): Promise<void> {
    const run = this.active;
    if (!run || run.state === 'cancelled' || run.state === 'done' || run.state === 'failed') return;
    // Synchronous part first: nothing after this point may reach the workspace.
    run.state = 'cancelled';
    run.sealedSessions.push(run.sessionId);
    this.pending = [];
    this.abort?.abort();
    try { this.review.discardPending(); } catch (e) { log('stop: discardPending failed', String(e)); }
    this.setState('cancelled');
    this.emit('stream', [{ kind: 'turn-done', status: 'cancelled' }] as UiStreamEvent[]);
    log('run.stop', run.id);
    if (run.sessionId) await this.tf.cancel(run.sessionId);
  }

  async resolveApproval(allow: boolean, reason?: string): Promise<void> {
    const run = this.active;
    const p = this.pending.shift();
    if (!run || !p || run.state === 'cancelled') return;
    this.emit('stream', [{ kind: 'approval', toolCallId: p.toolCallId, name: p.name, status: allow ? 'allowed' : 'denied', reason }] as UiStreamEvent[]);
    run.state = 'streaming';
    this.setState('streaming');
    const stream = this.tf.approve({
      sessionId: run.sessionId, turnId: this.turnId, threadId: p.threadId, toolCallId: p.toolCallId,
      allow, reason, afterEventId: this.lastEventId,
    });
    await this.consume(run, stream);
  }

  isToolCallAllowed(): boolean {
    return !(this.active && this.active.state === 'cancelled');
  }

  // ---- internals ----

  private async runTurn(run: Run, content: string): Promise<void> {
    this.abort = new AbortController();
    await this.consume(run, this.tf.streamTurn(run.sessionId, content, this.abort.signal));
  }

  /** Reads one stream until it ends or pauses on approvals; auto-denies pending approvals (S0). */
  private async consume(run: Run, stream: AsyncIterable<TfEvent>): Promise<void> {
    try {
      for await (const raw of stream) {
        if (run.state === 'cancelled' || run.sealedSessions.includes(run.sessionId)) return;
        const ev = raw as Ev;
        if (ev.id) this.lastEventId = ev.id;
        const out = this.map(run, ev);
        if (out.length) this.emit('stream', out);
        if (ev.type === 'turn.update' && ev.state?.status === 'paused' && this.pending.length) break;
        if (ev.type === 'turn.done') return;
      }
    } catch (e) {
      if (run.state === 'cancelled') return;
      this.fail(run, String((e as Error)?.message ?? e));
      return;
    }
    if (run.state === 'cancelled') return;
    if (this.pending.length) {
      // Slice 0: no review flow yet.
      await this.resolveApproval(false, 'not implemented in base');
      return;
    }
    if (run.state === 'streaming') {
      // Stream ended without turn.done (dropped connection): treat as done, log it.
      log('run: stream ended without turn.done', run.id);
      run.state = 'done';
      this.setState('done');
    }
  }

  private map(run: Run, ev: Ev): UiStreamEvent[] {
    switch (ev.type) {
      case 'turn.created':
        if (typeof ev.turnId === 'string') this.turnId = ev.turnId;
        return [];
      case 'model.message.delta':
        if (ev.id) this.streamedIds.add(ev.id);
        return typeof ev.content === 'string' && ev.content
          ? [{ kind: 'text-delta', text: ev.content, threadId: ev.threadId }] : [];
      case 'model.message': {
        if (ev.id) this.messages.set(ev.id, ev);
        const out: UiStreamEvent[] = [];
        const text = typeof ev.content === 'string' ? ev.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : Array.isArray(ev.content) ? ev.content.map((c: any) => c?.text ?? '').join('') : '';
        if (text && !(ev.id && this.streamedIds.has(ev.id))) out.push({ kind: 'text-delta', text, threadId: ev.threadId });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const tc of (ev.toolCalls ?? []) as any[]) {
          const d = describeCall(tc);
          out.push({ kind: 'tool-call', toolCallId: tc.id, name: d.name, args: d.args, deferred: d.deferred, threadId: ev.threadId });
        }
        return out;
      }
      case 'tool.response':
        return [{ kind: 'tool-result', toolCallId: ev.toolCallId, summary: String(ev.content ?? '').slice(0, 300) }];
      case 'tool.approval_required': {
        const out: UiStreamEvent[] = [];
        for (const ref of (ev.toolCalls ?? []) as Array<{ id: string; sourceEventId: string }>) {
          const msg = this.messages.get(ref.sourceEventId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tc = ((msg?.toolCalls ?? []) as any[]).find((t) => t.id === ref.id);
          const name = tc ? describeCall(tc).name : 'unknown';
          log('approval_required', JSON.stringify({ ref, name, args: tc?.function?.arguments }));
          this.pending.push({ threadId: ev.threadId, toolCallId: ref.id, name });
          out.push({ kind: 'approval', toolCallId: ref.id, name, status: 'pending' });
        }
        return out;
      }
      case 'turn.done': {
        const st = ev.state ?? {};
        if (st.status === 'done') {
          run.state = 'done';
          this.setState('done');
          return [{ kind: 'turn-done', status: 'done' }];
        }
        if (st.status === 'cancelled') {
          run.state = 'cancelled';
          this.setState('cancelled');
          return [{ kind: 'turn-done', status: 'cancelled' }];
        }
        run.state = 'failed';
        this.setState('failed', String(st.message ?? 'turn error'));
        return [{ kind: 'turn-done', status: 'error', error: String(st.message ?? 'turn error') }];
      }
      default:
        log('tf event', ev.type);
        return [];
    }
  }

  private fail(run: Run, message: string): void {
    log('run.failed', run.id, message);
    run.state = 'failed';
    this.setState('failed', message);
    this.emit('stream', [{ kind: 'turn-done', status: 'error', error: message }] as UiStreamEvent[]);
  }

  private setState(state: Run['state'], banner?: string): void {
    const msg: RunStateMsg = { state, agent: this.active?.agent, banner };
    this.emit('state', msg);
  }
}

/** Deferred tools are invoked through TrueForge's `call_tool` wrapper (args: mcp_server, tool_name, ...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeCall(tc: any): { name: string; args: unknown; deferred: boolean } {
  const fn = tc?.function ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let args: any;
  try { args = JSON.parse(fn.arguments ?? '{}'); } catch { args = fn.arguments; }
  if (fn.name === 'call_tool' && args && typeof args === 'object' && args.tool_name) {
    return { name: String(args.tool_name), args, deferred: true };
  }
  return { name: String(fn.name ?? 'unknown'), args, deferred: false };
}

function buildFirstMessage(mode: 'inline' | 'agent', text: string, sel?: Selection): string {
  if (mode !== 'inline' || !sel) return text;
  return [
    `[INLINE EDIT] File: ${sel.path} lines ${sel.startLine + 1}-${sel.endLine + 1} (baseHash ${sel.hash}).`,
    `Instruction: ${text}`,
    'Selected code:',
    '```',
    sel.text,
    '```',
    'Rules: change only what the instruction needs, prefer staying inside the selection, call propose_write once with exact oldText copied from the file and the baseHash above.',
  ].join('\n');
}
