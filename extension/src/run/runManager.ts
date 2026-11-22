import { previewSelection } from '../context/tokens';
import type { ReviewCheckpoint } from './reviewCheckpoint';
/**
 * run/runManager.ts - C2 owner of the single active Run. (Slice 1: streaming, approvals, Stop.)
 *
 * Exports:
 *  - class RunManager extends EventEmitter. Events: 'state'(RunStateMsg), 'stream'(UiStreamEvent[]),
 *    'session'({sessionId, agent, url}).
 *    - start(mode, text, selection?): create session on cfg.primaryAgent, build first message
 *      (inline: path/lines/baseHash/selected text template; agent: the text), consume() the turn.
 *      Rejects while a run is streaming or awaiting review; allowed again after done/cancelled/failed.
 *    - send(text): follow-up turn on the same session (starts a new agent run if none usable).
 *    - consume(): loops over the turn stream, tracks turnId (turn.created) and lastEventId, maps
 *      events to UiStreamEvent, ignores events once cancelled / sealed.
 *    - tool.approval_required: queued, then handled one at a time once the stream pauses.
 *      propose_write -> review.beginProposal (onResolve wired to resolveApproval); {deny} -> deny at
 *      once, else state 'awaiting-review' (hunk count from review.pending). run_command asks the user; any other tool is auto-denied.
 *    - resolveApproval(allow, reason?): approve() resumed stream (subscribeToTurn + user.tool_approval),
 *      which is consumed in turn.
 *    - stop(): synchronous first (state='cancelled', abort stream, review.discardPending(), killAll()),
 *      emits state, logs the local latency, then awaits tf.cancel(). Late events are ignored.
 *    - isToolCallAllowed(): false only while the active run is cancelled (MCP tools check this).
 *
 * Fallback (S8): turn.done error / thrown error / no first event within cfg.firstEventTimeoutMs on the
 * primary -> classifyDetailed -> model-failure => takeOver (once per run, never after Stop or after an
 * approved write); trueforgeDown => failed "TrueForge not reachable at <url>"; fallback failing too =>
 * failed "Both models failed: ...". The original first message is kept for replay.
 *
 * run_command (S7): approval goes through the injected askCommandApproval(argv) (default deny); Allow ->
 * resolveApproval(true), Deny/dismiss -> resolveApproval(false,'user denied command'); duplicates ignored.
 * Rules: one active run only; never writes to disk.
 * Depends on: types, config, run/tfClient, review/diffView, mcp/runCommand, log. Depended on by: extension, mcp/tools, shell/inlineEdit.
 */
import { randomUUID } from 'node:crypto';
import type { RecordEvidence, RunEvidence } from './journal';
import { EventEmitter } from 'node:events';
import type { ContexoConfig } from '../config';
import type { ReviewEngine } from '../review/diffView';
import type { ProposeArgs, Run, RunStateMsg, Selection, TfEvent, UiStreamEvent } from '../types';
import { ApprovalDeliveryUnknown, type TfClient } from './tfClient';
import { killAll } from '../mcp/runCommand';
import { classifyDetailed, takeOver, type Classification } from './fallback';
import { log } from '../log';
import { Timer } from '../metrics';
import { resolveRequirementRefs, splitRequirements } from '../review/requirements';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = { type: string; id?: string; [k: string]: any };

interface PendingApproval { threadId: string; toolCallId: string; name: string; args: unknown }

export type RunReview = Pick<ReviewEngine, 'pending' | 'beginProposal' | 'attachProposal' | 'discardPending' | 'onResolve'>;

export class RunManager extends EventEmitter {
  active?: Run;
  private stopLatencyMs?: number;
  get lastStopMs(): number | undefined { return this.stopLatencyMs; }

  private tf: TfClient;
  private review: RunReview;
  private cfg: ContexoConfig;
  private readonly record?: RecordEvidence;
  private readonly flushEvidence?: () => Promise<void>;
  private readonly workspaceUri?: () => string | undefined;
  private turnId = '';
  private lastEventId = '';
  private abort?: AbortController;
  private pending: PendingApproval[] = [];
  private messages = new Map<string, Ev>();        // model.message events by id (tool-call lookup)
  private receivedEvents = new Set<string>();
  private approvalIds = new Set<string>();
  private streamedText = new Map<string, string>();
  private runRequirements: Array<{ id: string; text: string }> = []; // agent-mode requirement parts of the active run, in R1.. order
  private firstMessage = '';                       // original first message, replayed on fallback
  private fallbackUsed = false;
  private primaryReason = '';
  private banner?: string;
  private firstTimer?: ReturnType<typeof setTimeout>;
  private sawActivity = false;                     // a model/tool event arrived in the current turn
  private approvedAny = false;                     // a write was approved: fallback replay would be unsafe

  private askCommandApproval: (argv: string[]) => Promise<boolean>;

  constructor(deps: { tf: TfClient; review: RunReview; cfg: ContexoConfig; record?: RecordEvidence; flushEvidence?: () => Promise<void>; workspaceUri?: () => string | undefined; askCommandApproval?: (argv: string[]) => Promise<boolean> }) {
    super();
    this.askCommandApproval = deps.askCommandApproval ?? (async () => false);
    this.tf = deps.tf;
    this.record = deps.record;
    this.flushEvidence = deps.flushEvidence;
    this.workspaceUri = deps.workspaceUri;
    this.review = deps.review;
    this.cfg = deps.cfg;
  }

  checkpoint(proposal: ReviewCheckpoint['proposal'], root: string): ReviewCheckpoint | undefined {
    if (!this.active || this.active.id !== proposal.runId || !this.turnId) return undefined;
    return { run: structuredClone(this.active), proposal: structuredClone(proposal), turnId: this.turnId,
      root, runtime: this.cfg.trueforgeUrl };
  }

  async restoreReview(saved: ReviewCheckpoint): Promise<void> {
    if (this.active?.state === 'streaming' || this.active?.state === 'awaiting-review') {
      throw new Error('Finish the current run before restoring a review.');
    }
    if (saved.runtime !== this.cfg.trueforgeUrl || !this.tf.resumeReview) {
      throw new Error('Restore the original TrueForge connection before resuming this review.');
    }
    const run = structuredClone(saved.run);
    run.state = 'awaiting-review';
    this.active = run;
    try {
      this.lastEventId = await this.tf.resumeReview(run, saved.turnId, saved.proposal.toolCallId, saved.proposal.threadId);
      if ((run.state as Run['state']) === 'cancelled') return;
      this.turnId = saved.turnId;
      this.pending = [{ threadId: saved.proposal.threadId, toolCallId: saved.proposal.toolCallId, name: 'propose_write', args: undefined }];
      this.messages.clear();
      this.streamedText.clear();
      this.abort = undefined;
      this.fallbackUsed = true;
      this.approvedAny = false;
      this.review.onResolve = (allow, reason) => {
        void this.resolveApproval(allow, reason).catch(error => this.fail(run, String(error)));
      };
      await this.review.attachProposal(run, structuredClone(saved.proposal));
      this.publishSession(run, { sessionId: run.sessionId, agent: run.agent, url: this.tf.sessionUrl(run.sessionId) });
      this.publishState({ state: 'awaiting-review', agent: run.agent, hunks: saved.proposal.hunks.length });
    } catch (error) {
      if (this.active === run) this.active = undefined;
      this.pending = [];
      throw error;
    }
  }

  async confirmReview(proposal: ReviewCheckpoint['proposal']): Promise<void> {
    const run = this.active;
    if (!this.tf.resumeReview || !run || run.id !== proposal.runId || !this.turnId) return;
    this.lastEventId = await this.tf.resumeReview(run, this.turnId, proposal.toolCallId, proposal.threadId, false);
  }

  async start(mode: 'inline' | 'agent', text: string, selection?: Selection): Promise<void> {
    const cur = this.active;
    if (cur && (cur.state === 'streaming' || cur.state === 'awaiting-review')) {
      throw new Error('A Contexo run is already active. Stop it first.');
    }
    if (this.review.pending?.runId) throw new Error('Finish the open editor review before starting another run.');
    const agent = this.cfg.primaryAgent;
    const run: Run = {
      id: randomUUID(), mode, request: text, selection, workspaceUri: this.workspaceUri?.(),
      sessionId: '', agent: agent as Run['agent'], state: 'streaming', sealedSessions: [],
    };
    this.active = run;
    this.pending = [];
    this.messages.clear();
    this.streamedText.clear();
    this.turnId = '';
    this.lastEventId = '';
    this.fallbackUsed = false;
    this.primaryReason = '';
    this.banner = undefined;
    this.approvedAny = false;
    this.clearTimer();
    this.firstMessage = buildFirstMessage(mode, text, selection);
    this.capture(run, { kind: 'request', mode, text });
    this.runRequirements = mode === 'agent' ? splitRequirements(text).map(part => ({ id: randomUUID(), text: part })) : [];
    for (const part of this.runRequirements) {
      this.capture(run, { kind: 'requirement', requirementId: part.id, requirementText: part.text, requirementRevision: 1 });
    }
    this.setState('streaming');
    try {
      run.sessionId = await this.tf.createSession(agent, run);
    } catch (e) {
      await this.handleFailure(run, classifyDetailed(e), `Could not create a TrueForge session: ${String(e)}`);
      return;
    }
    if (run.state === 'cancelled') return;
    this.publishSession(run, { sessionId: run.sessionId, agent, url: this.tf.sessionUrl(run.sessionId) });
    log('run.start', run.id, mode, run.sessionId);
    await this.runTurn(run, this.firstMessage);
  }

  async send(text: string): Promise<void> {
    const run = this.active;
    if (!run || run.state === 'cancelled' || run.state === 'failed' ||
        (run.state === 'done' && this.workspaceUri && run.workspaceUri !== this.workspaceUri())) {
      return this.start('agent', text);
    }
    if (run.state === 'streaming' || run.state === 'awaiting-review') {
      this.emit('stream', [{ kind: 'info', text: 'A turn is still running. Stop it before sending another message.' }] as UiStreamEvent[]);
      return;
    }
    run.state = 'streaming';
    this.capture(run, { kind: 'request', mode: run.mode, text }, false);
    this.setState('streaming');
    await this.runTurn(run, text);
  }

  async stop(): Promise<void> {
    const timer = Timer.start();
    const run = this.active;
    if (!run || run.state === 'cancelled' || run.state === 'done' || run.state === 'failed') return;
    // Synchronous part first: nothing after this point may reach the workspace.
    run.state = 'cancelled';
    run.sealedSessions.push(run.sessionId);
    this.clearTimer();
    this.pending = [];
    this.abort?.abort();
    try { this.review.discardPending(); } catch (e) { log('stop: discardPending failed', String(e)); }
    const cleanup = killAll(run.id).catch(e => log('stop: killAll failed', String(e)));
    this.setState('cancelled');
    this.emit('stream', [{ kind: 'turn-done', status: 'cancelled' }] as UiStreamEvent[]);
    await cleanup;
    const value = timer.elapsedMs();
    this.stopLatencyMs = value;
    this.capture(run, { kind: 'metric', name: 'stopLatencyMs', value }, false);
    log(`[stop] local stop in ${value}ms`, run.id);
    if (run.sessionId) {
      try { await this.tf.cancel(run.sessionId); } catch (e) { log('stop: tf.cancel failed', String(e)); }
    }
  }

  async resolveApproval(allow: boolean, reason?: string): Promise<void> {
    const run = this.active;
    if (!run || run.state === 'cancelled' || run.state === 'done' || run.state === 'failed') return;
    const p = this.pending.shift();
    if (!p) return;
    this.record?.(run.id, { kind: 'approval-intent', toolCallId: p.toolCallId, threadId: p.threadId, allow },
      { sessionId: run.sessionId, turnId: this.turnId });
    if (this.flushEvidence) await this.flushEvidence();
    if (this.active !== run || !this.isToolCallAllowed()) return;
    this.publishEvents(run, [{ kind: 'approval', toolCallId: p.toolCallId, name: p.name, status: allow ? 'allowed' : 'denied', reason }]);
    if (allow) this.approvedAny = true;
    run.state = 'streaming';
    this.setState('streaming');
    this.abort ??= new AbortController();
    const stream = this.tf.approve({
      sessionId: run.sessionId, turnId: this.turnId, threadId: p.threadId, toolCallId: p.toolCallId,
      allow, reason, afterEventId: this.lastEventId, signal: this.abort.signal,
    });
    await this.consume(run, stream);
  }

  isToolCallAllowed(): boolean {
    return !(this.active && this.active.state === 'cancelled');
  }

  // ---- internals ----

  private async runTurn(run: Run, content: string): Promise<void> {
    this.abort = new AbortController();
    this.sawActivity = false;
    this.turnId = '';
    this.lastEventId = '';
    this.messages.clear();
    this.streamedText.clear();
    this.receivedEvents.clear();
    this.approvalIds.clear();
    this.armTimer(run);
    try {
      await this.consume(run, this.tf.streamTurn(run.sessionId, content, this.abort.signal));
    } finally {
      this.clearTimer();
    }
  }

  private armTimer(run: Run): void {
    this.clearTimer();
    const ms = this.cfg.firstEventTimeoutMs;
    if (!(ms > 0)) return;
    const sid = run.sessionId;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = undefined;
      if (run.state === 'cancelled' || run.sessionId !== sid) return;
      const reason = `no response within ${Math.round(ms / 1000)}s`;
      log('run: first-event timeout', run.id, reason);
      run.sealedSessions.push(sid);
      this.abort?.abort();
      void this.tf.cancel(sid).catch(() => {});
      void this.handleFailure(run, { kind: 'model-failure', reason, trueforgeDown: false }, reason);
    }, ms);
  }

  private clearTimer(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = undefined;
  }

  /** Routes a failure: TrueForge down -> failed; primary model failure -> fallback; else failed. */
  private async handleFailure(run: Run, c: Classification, message: string): Promise<void> {
    if (run.state === 'cancelled') return;
    this.clearTimer();
    if (c.trueforgeDown) {
      this.fail(run, `TrueForge not reachable at ${this.cfg.trueforgeUrl}`, true);
      return;
    }
    if (c.kind === 'model-failure' && this.cfg.primaryAgent !== this.cfg.fallbackAgent && !this.fallbackUsed && !this.approvedAny) {
      this.fallbackUsed = true;
      this.primaryReason = c.reason;
      try {
        await takeOver(run, {
          tf: this.tf, cfg: this.cfg, reason: c.reason, firstMessage: this.firstMessage,
          reset: () => {
            this.pending = [];
            this.messages.clear();
            this.streamedText.clear();
            this.turnId = '';
            this.lastEventId = '';
            try { this.review.discardPending(); } catch (e) { log('takeOver: discardPending failed', String(e)); }
          },
          emitSession: (info) => this.publishSession(run, info),
          emitState: (m) => { this.banner = m.banner; this.publishState(m); },
          runTurn: (r, content) => this.runTurn(r, content),
        });
      } catch (e) {
        if ((run.state as Run['state']) === 'cancelled') return;
        this.fail(run, classifyDetailed(e).reason);
      }
      return;
    }
    this.fail(run, this.fallbackUsed ? c.reason : message);
  }

  /** Reads one stream until it ends or pauses on approvals, then routes the pending approvals. */
  private async consume(run: Run, stream: AsyncIterable<TfEvent>, reattached = false): Promise<void> {
    const sid = run.sessionId;
    const stale = () => run.state === 'cancelled' || run.sessionId !== sid || run.sealedSessions.includes(sid);
    try {
      for await (const raw of stream) {
        if (stale()) return;
        const ev = raw as Ev;
        if (ev.id && ev.type !== 'model.message.delta') {
          const complete = ev.type !== 'model.message' || !!ev.content || (ev.toolCalls?.length ?? 0) > 0;
          if (complete) {
            const receipt = ev.type + ':' + ev.id;
            if (this.receivedEvents.has(receipt)) continue;
            this.receivedEvents.add(receipt);
          }
          this.lastEventId = ev.id;
        }
        if (ev.type.startsWith('model.') || ev.type.startsWith('tool.')) {
          this.sawActivity = true;
          this.clearTimer();
        }
        if (ev.type === 'turn.done' && ev.state?.status === 'error') {
          await this.handleFailure(run, classifyDetailed(ev), String(ev.state.message ?? 'turn error'));
          return;
        }
        const out = this.map(run, ev);
        if (ev.type === 'tool.response' && typeof ev.toolCallId === 'string') {
          this.capture(run, { kind: 'tool-output', toolCallId: ev.toolCallId, content: ev.content });
        }
        this.publishEvents(run, out);
        if (ev.type === 'turn.update' && ev.state?.status === 'paused' && this.pending.length) break;
        if (ev.type === 'turn.done') return;
      }
    } catch (e) {
      if (stale()) return;
      if (e instanceof ApprovalDeliveryUnknown) {
        this.fail(run, e.message, true);
        return;
      }
      if (await this.reconnect(run, sid, reattached)) return;
      await this.handleFailure(run, classifyDetailed(e, { sawActivity: this.sawActivity }), String((e as Error)?.message ?? e));
      return;
    }
    if (stale()) return;
    if (this.pending.length) {
      await this.processPending(run);
      return;
    }
    if (run.state !== 'streaming') return;
    const turnId = this.turnId;
    try {
      const state = turnId ? await this.tf.readTurnState?.(sid, turnId) : undefined;
      if (stale()) return;
      if (state) this.capture(run, { kind: 'reconciliation', status: state.status });
      if (state?.status === 'error') {
        await this.handleFailure(run, classifyDetailed({ type: 'turn.done', state }), state.message ?? 'TrueForge reported a failed turn.');
        return;
      }
      if (state?.status === 'done' || state?.status === 'cancelled') {
        this.publishEvents(run, this.map(run, { type: 'turn.done', state }));
        return;
      }
      if (await this.reconnect(run, sid, reattached, state?.status)) return;
      this.fail(run, 'The stream ended before TrueForge confirmed completion. Check the Session tab for the latest state.', true);
    } catch (error) {
      if (!stale()) this.fail(run, `Could not confirm the final TrueForge turn state: ${String(error)}`, true);
    }
  }

  private async reconnect(run: Run, sessionId: string, attempted: boolean, observedStatus?: string): Promise<boolean> {
    if (attempted || !this.turnId || !this.lastEventId || !this.tf.subscribeExisting) return false;
    const turnId = this.turnId;
    const status = observedStatus ?? (await this.tf.readTurnState?.(sessionId, turnId).catch(() => undefined))?.status;
    if (this.active !== run || run.sessionId !== sessionId || !this.isToolCallAllowed()) return true;
    if (status === 'done' || status === 'cancelled') {
      this.publishEvents(run, this.map(run, { type: 'turn.done', state: { status } }));
      return true;
    }
    if (!status || ['error', 'failed'].includes(status)) return false;
    this.capture(run, { kind: 'reconciliation', status: 'reattaching to ' + status + ' turn' });
    if (this.flushEvidence) await this.flushEvidence();
    if (this.active !== run || run.sessionId !== sessionId || !this.isToolCallAllowed()) return true;
    if (status === 'paused' && this.pending.length) {
      await this.processPending(run);
      return true;
    }
    const cursor = status === 'paused' ? '' : this.lastEventId;
    await this.consume(run, this.tf.subscribeExisting(sessionId, turnId, cursor, this.abort?.signal), true);
    return true;
  }

  /** Handles the head of the pending-approval queue; the rest follow after each resolution. */
  private async processPending(run: Run): Promise<void> {
    const p = this.pending[0];
    if (!p || run.state === 'cancelled') return;
    if (p.name === 'run_command') {
      const argv = parseArgv(p.args);
      if (!argv) {
        await this.resolveApproval(false, 'run_command arguments could not be parsed');
        return;
      }
      // Asking about a program the runner will refuse anyway only stalls the run; deny it with the reason.
      const allowlist = this.cfg.commandAllowlist ?? ['python', 'pytest', 'flask'];
      const prog = argv[0].split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
      if (!allowlist.some((a) => a.toLowerCase() === prog)) {
        await this.resolveApproval(false, `COMMAND_NOT_ALLOWED: ${argv[0]} is not in the allowlist (${allowlist.join(', ')})`);
        return;
      }
      const id = p.toolCallId;
      let answered = false; // a duplicate answer for the same toolCallId is ignored
      const answer = async (allow: boolean) => {
        if (answered || this.pending[0]?.toolCallId !== id) return;
        answered = true;
        await this.resolveApproval(allow, allow ? undefined : 'user denied command');
      };
      let allow = false;
      try { allow = await this.askCommandApproval(argv); } catch (e) { log('askCommandApproval failed', String(e)); }
      await answer(allow);
      return;
    }
    if (p.name !== 'propose_write') {
      await this.resolveApproval(false, `tool ${p.name} is not supported`);
      return;
    }
    const args = parseProposeArgs(p.args);
    if (!args) {
      await this.resolveApproval(false, 'propose_write arguments could not be parsed');
      return;
    }
    this.review.onResolve = (allow, reason) => {
      void this.resolveApproval(allow, reason).catch((e) => this.fail(run, String((e as Error)?.message ?? e)));
    };
    let res: 'reviewing' | { deny: string };
    try {
      res = await this.review.beginProposal(run, p.toolCallId, p.threadId, args);
    } catch (e) {
      res = { deny: `review failed: ${String((e as Error)?.message ?? e)}` };
    }
    if ((run.state as Run["state"]) === "cancelled") return;
    if (typeof res === 'object') {
      this.review.onResolve = undefined;
      await this.resolveApproval(false, res.deny);
      return;
    }
    const staged = this.review.pending;
    if (staged && args.requirements?.length) {
      for (const id of resolveRequirementRefs(args.requirements, this.runRequirements)) {
        const part = this.runRequirements.find(r => r.id === id)!;
        this.capture(run, {
          kind: 'requirement-link', requirementId: id, requirementText: part.text, requirementRevision: 1,
          proposalKey: staged.key, hunkIds: staged.hunks.map(h => h.id), checkSequences: [], source: 'agent',
        });
      }
    }
    if (run.state === 'streaming') {
      run.state = 'awaiting-review';
      const hunks = this.review.pending?.hunks.length;
      this.publishState({ state: 'awaiting-review', agent: run.agent, hunks });
    }
  }

  private map(run: Run, ev: Ev): UiStreamEvent[] {
    switch (ev.type) {
      case 'turn.created':
        if (typeof ev.turnId === 'string') this.turnId = ev.turnId;
        return [];
      case 'model.message.delta': {
        const text = typeof ev.content === 'string' ? ev.content : '';
        if (!text) return [];
        if (ev.id) this.streamedText.set(ev.id, (this.streamedText.get(ev.id) ?? '') + text);
        return [{ kind: 'text-delta', text, threadId: ev.threadId }];
      }
      case 'model.message': {
        if (ev.id && (ev.content || ev.toolCalls?.length || !this.messages.has(ev.id))) this.messages.set(ev.id, ev);
        const out: UiStreamEvent[] = [];
        const text = typeof ev.content === 'string' ? ev.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : Array.isArray(ev.content) ? ev.content.map((c: any) => c?.text ?? '').join('') : '';
        const rendered = ev.id ? this.streamedText.get(ev.id) : undefined;
        const suffix = rendered ? text.startsWith(rendered) ? text.slice(rendered.length) : '' : text;
        if (suffix) {
          if (ev.id) this.streamedText.set(ev.id, (rendered ?? '') + suffix);
          out.push({ kind: 'text-delta', text: suffix, threadId: ev.threadId });
        }
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
          const approvalId = ev.threadId + ':' + ref.id;
          if (this.approvalIds.has(approvalId)) continue;
          this.approvalIds.add(approvalId);
          const msg = this.messages.get(ref.sourceEventId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tc = ((msg?.toolCalls ?? []) as any[]).find((t) => t.id === ref.id);
          const d = tc ? describeCall(tc) : undefined;
          const name = d?.name ?? 'unknown';
          log('approval_required', ref.id, name);
          this.pending.push({ threadId: ev.threadId, toolCallId: ref.id, name, args: d?.args });
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
        const msg = String(st.message ?? 'turn error');
        run.state = 'failed';
        this.setState('failed', msg);
        return [
          { kind: 'info', text: `Run failed: ${msg}` },
          { kind: 'turn-done', status: 'error', error: msg },
        ];
      }
      default:
        log('tf event', ev.type);
        return [];
    }
  }

  private fail(run: Run, reason: string, raw = false): void {
    const message = this.fallbackUsed && !raw
      ? `Both models failed: ${this.primaryReason}; ${reason}. No files were changed.`
      : reason;
    log('run.failed', run.id, message);
    run.state = 'failed';
    this.setState('failed', message);
    this.emit('stream', [
      { kind: 'info', text: `Run failed: ${message}` },
      { kind: 'turn-done', status: 'error', error: message },
    ] as UiStreamEvent[]);
  }

  private setState(state: Run['state'], failure?: string): void {
    const msg: RunStateMsg = { state, agent: this.active?.agent, banner: state === 'failed' ? failure : this.banner };
    this.publishState(msg);
  }

  recordContext(run: Run | undefined, evidence: RunEvidence): void {
    if (run && this.active === run) this.capture(run, evidence);
  }

  private capture(run: Run, evidence: RunEvidence, includeTurn = true): void {
    this.record?.(run.id, evidence, {
      sessionId: run.sessionId || undefined,
      turnId: includeTurn ? this.turnId || undefined : undefined,
    });
  }

  private publishState(message: RunStateMsg): void {
    if (this.active) this.capture(this.active, { kind: 'state', state: message.state, detail: message.banner });
    this.emit('state', message);
  }

  private publishSession(run: Run, session: { sessionId: string; agent: string; url: string }): void {
    this.capture(run, { kind: 'session', agent: session.agent }, false);
    this.emit('session', session);
  }

  private publishEvents(run: Run, events: UiStreamEvent[]): void {
    for (const event of events) {
      if (event.kind !== 'text-delta') this.capture(run, { kind: 'agent-event', event });
    }
    if (events.length) this.emit('stream', events);
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

/** Extracts ProposeArgs from a call's args; deferred calls may wrap them inside call_tool's args. */
function parseProposeArgs(raw: unknown): ProposeArgs | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tryOne = (v: any): ProposeArgs | undefined => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
    return v && typeof v === 'object' && Array.isArray(v.edits) ? (v as ProposeArgs) : undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = raw as any;
  if (!o || typeof o !== 'object') return tryOne(o);
  return tryOne(o) ?? tryOne(o.arguments) ?? tryOne(o.args) ?? tryOne(o.tool_arguments) ?? tryOne(o.input);
}

/** Extracts argv from a run_command call's args (possibly wrapped by call_tool). */
function parseArgv(raw: unknown): string[] | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (v: any): string[] | undefined => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
    if (!v || typeof v !== 'object') return undefined;
    if (Array.isArray(v.argv) && v.argv.length && v.argv.every((x: unknown) => typeof x === 'string')) return v.argv;
    return undefined;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = raw as any;
  return find(o) ?? (o && typeof o === 'object' ? find(o.arguments) ?? find(o.args) ?? find(o.tool_arguments) ?? find(o.input) : undefined);
}

const AGENT_HINT =
  'Use assemble_context first. Stage related edits (implementation, tests, docs) in as few propose_write calls as is natural. ' +
  'After the user applies, run the relevant tests with run_command.';

function buildFirstMessage(mode: 'inline' | 'agent', text: string, sel?: Selection): string {
  if (mode === 'agent') return `${text}

${AGENT_HINT}`;
  if (!sel) return text;
  const preview = previewSelection(sel.text);
  return [
    `[INLINE EDIT] File: ${sel.path} lines ${sel.startLine + 1}-${sel.endLine + 1} (baseHash ${sel.hash}).`,
    `Instruction: ${text}`,
    preview.truncated ? 'Selected code preview. Use read_file for exact ranges before proposing an edit:' : 'Selected code:',
    '```',
    preview.text,
    '```',
    'Rules: change only what the instruction needs, prefer staying inside the selection, call propose_write once with exact oldText copied from the file and the baseHash above.',
  ].join('\n');
}
