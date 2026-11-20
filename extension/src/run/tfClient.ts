/**
 * run/tfClient.ts - C2 thin wrapper over @truefoundry/trueforge-sdk (v0.185.0 camelCase API).
 * This is the ONLY file in the extension that imports the SDK.
 *
 * Exports:
 *  - createTfClient(cfg): TfClient
 *  - TfClient.createSession(agent): sessions.create({ agent: { name } }) -> data.id.
 *  - TfClient.streamTurn(sessionId, content, signal): sessions.createTurnStream(...). Yields every
 *    event as-is (model.message.delta included so the UI can stream). Deltas are merged
 *    (isEventDelta/mergeEventDelta) into a per-id model.message so tool-call args are complete; if a
 *    tool.approval_required arrives whose source message was only seen as deltas, the merged
 *    message is yielded first.
 *  - TfClient.approve(...): subscribeToTurn(afterEventId) then createTurnEvents(user.tool_approval),
 *    returns the resumed stream (same delta handling).
 *  - TfClient.cancel(sessionId): sessions.cancel (errors swallowed: idempotent).
 *  - TfClient.sessionUrl(sessionId): `${baseUrl}/sessions/${id}` (a GUESS, unverified - see spike notes).
 *  - TfClient.ping(): cheap sessions.list with a 3 s timeout, no retries; true/false.
 *
 *  - createSessionInspector(cfg): read-only Session tab data. recent(limit) -> sessions.list; load(id, sealed) ->
 *    sessions.get + listTurns + listTurnEvents (deltas merged via mergeEventDelta) mapped by run/timeline.
 *
 * Event shape: the SDK yields camelCase fields (threadId, toolCalls[{id, sourceEventId}], turnId).
 * Rules: no model provider SDK or URL anywhere.
 * Depends on: @truefoundry/trueforge-sdk, config, types, log. Depended on by: run/runManager, run/fallback, dev/devCommands.
 */
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import type { ContexoConfig } from '../config';
import type { SessionSummary, SessionView, TfEvent, TurnView } from '../types';
import { log } from '../log';
import { buildSessionView, buildTurnView } from './timeline';

export interface TfClient {
  createSession(agent: string): Promise<string>;
  streamTurn(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<TfEvent>;
  approve(a: { sessionId: string; turnId: string; threadId: string; toolCallId: string; allow: boolean; reason?: string; afterEventId: string; signal?: AbortSignal }): AsyncIterable<TfEvent>;
  readTurnState?(sessionId: string, turnId: string): Promise<{ status: string; message?: string }>;
  cancel(sessionId: string): Promise<void>;
  sessionUrl(sessionId: string): string;
  ping(): Promise<boolean>;
}

type AnyEvent = { type: string; id?: string; [k: string]: unknown };

/**
 * Wraps a raw SDK stream: merges deltas into per-id messages, yields all events.
 * LIVE FINDING (spike Q1): TrueForge streams an EMPTY `model.message` placeholder first and then only
 * `model.message.delta` events for that id, so the merged message must be yielded (as a complete
 * model.message) before the tool response / approval / end of turn that depends on it.
 */
export async function* withMerge(stream: AsyncIterable<unknown>): AsyncIterable<TfEvent> {
  const synthetic = new Map<string, AnyEvent>();   // messages seen as deltas
  const done = new Set<string>();                   // ids already yielded as complete (real or merged)
  const flush = function* (): Iterable<TfEvent> {
    for (const [id, m] of synthetic) {
      if (done.has(id)) continue;
      done.add(id);
      yield m as TfEvent;
    }
  };
  for await (const raw of stream) {
    const ev = raw as AnyEvent;
    if (isEventDelta(ev as { type: string })) {
      const id = ev.id as string;
      let base = synthetic.get(id);
      if (!base) {
        base = { type: 'model.message', id, threadId: ev.threadId, content: '', toolCalls: [] };
        synthetic.set(id, base);
      }
      mergeEventDelta(base as never, ev as never);
      yield ev;
      continue;
    }
    if (ev.type === 'model.message' && ev.id) {
      const full = (Array.isArray(ev.toolCalls) && ev.toolCalls.length > 0) || (typeof ev.content === 'string' && ev.content !== '');
      if (full) done.add(ev.id);
    }
    if (ev.type === 'tool.response' || ev.type === 'tool.approval_required' || ev.type === 'turn.done') yield* flush();
    yield ev as TfEvent;
  }
  yield* flush();
}

export function createTfClient(cfg: ContexoConfig): TfClient {
  const baseUrl = cfg.trueforgeUrl.replace(/\/+$/, '');
  const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });

  return {
    async createSession(agent) {
      const res = await client.sessions.create({ agent: { name: agent } });
      log('tf.createSession', agent, res.data.id);
      return res.data.id;
    },

    streamTurn(sessionId, content, signal) {
      return (async function* () {
        const stream = await client.sessions.createTurnStream(
          sessionId,
          { input: [{ type: 'user.message', content }] },
          { abortSignal: signal },
        );
        yield* withMerge(stream);
      })();
    },

    approve(a) {
      return (async function* () {
        const stream = await client.sessions.subscribeToTurn(a.sessionId, a.turnId, { afterEventId: a.afterEventId }, { abortSignal: a.signal });
        await client.sessions.createTurnEvents(a.sessionId, a.turnId, {
          events: [{
            type: 'user.tool_approval',
            threadId: a.threadId,
            toolCallId: a.toolCallId,
            approval: a.allow ? { status: 'allow' } : { status: 'deny', reason: a.reason },
          }],
        });
        yield* withMerge(stream);
      })();
    },

    async readTurnState(sessionId, turnId) {
      const { data } = await client.sessions.getTurn(sessionId, turnId, { timeoutInSeconds: 5, maxRetries: 0 });
      const state = data.state;
      return { status: state.status, message: 'message' in state && typeof state.message === 'string' ? state.message : undefined };
    },

    async cancel(sessionId) {
      try {
        await client.sessions.cancel(sessionId);
      } catch (e) {
        log('tf.cancel error (ignored)', String(e));
      }
    },

    sessionUrl: (sessionId) => `${baseUrl}/sessions/${sessionId}`,

    async ping() {
      try {
        await client.sessions.list({ limit: 1 }, { timeoutInSeconds: 3, maxRetries: 0 });
        return true;
      } catch (e) {
        log('tf.ping failed', String(e));
        return false;
      }
    },
  };
}

/** Persisted events normally have no deltas; if an in-flight turn returns some, merge them into model.message events. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mergeStoredDeltas(events: any[]): any[] {
  const out: AnyEvent[] = [];
  const synthetic = new Map<string, AnyEvent>();
  const real = new Set<string>(events.filter((e) => e.type === 'model.message').map((e) => e.id as string));
  for (const ev of events) {
    if (isEventDelta(ev as { type: string })) {
      const id = ev.id as string;
      if (real.has(id)) continue;
      let base = synthetic.get(id);
      if (!base) {
        base = { type: 'model.message', id, threadId: ev.threadId, content: '', toolCalls: [] };
        synthetic.set(id, base);
        out.push(base);
      }
      mergeEventDelta(base as never, ev as never);
      continue;
    }
    out.push(ev);
  }
  return out;
}

export interface SessionInspector {
  recent(limit?: number): Promise<SessionSummary[]>;
  load(sessionId: string, sealed: boolean): Promise<SessionView>;
}

export function createSessionInspector(cfg: Pick<ContexoConfig, 'trueforgeUrl' | 'primaryAgent' | 'fallbackAgent'>): SessionInspector {
  const client = new TrueForge({ baseUrl: cfg.trueforgeUrl.replace(/\/+$/, ''), timeoutInSeconds: 30 });
  return {
    async recent(limit = 20) {
      const page = await client.sessions.list({ limit });
      return page.data.map((s) => ({
        id: s.id,
        agent: s.agent.type === 'reference' ? String(s.agent.name ?? s.agent.id) : 'inline agent',
        title: s.title ?? undefined,
        createdAt: s.createdAt,
        status: s.lastTurnDetails?.state.status,
      }));
    },

    async load(sessionId, sealed) {
      const session = (await client.sessions.get(sessionId)).data;
      const turns: TurnView[] = [];
      let page = await client.sessions.listTurns(sessionId, { limit: 25 });
      const raw = [...page.data];
      while (page.hasNextPage() && raw.length < 200) { page = await page.getNextPage(); raw.push(...page.data); }
      raw.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const turn of raw) {
        const events: unknown[] = [];
        let ep = await client.sessions.listTurnEvents(sessionId, turn.id, { limit: 200, order: 'asc' });
        events.push(...ep.data);
        while (ep.hasNextPage() && events.length < 5000) { ep = await ep.getNextPage(); events.push(...ep.data); }
        turns.push(buildTurnView(turn, mergeStoredDeltas(events)));
      }
      return buildSessionView(session, turns, { primaryAgent: cfg.primaryAgent, fallbackAgent: cfg.fallbackAgent, sealed });
    },
  };
}
