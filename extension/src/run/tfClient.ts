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
 * Event shape: the SDK yields camelCase fields (threadId, toolCalls[{id, sourceEventId}], turnId).
 * Rules: no model provider SDK or URL anywhere.
 * Depends on: @truefoundry/trueforge-sdk, config, types, log. Depended on by: run/runManager, run/fallback, dev/devCommands.
 */
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import type { ContexoConfig } from '../config';
import type { TfEvent } from '../types';
import { log } from '../log';

export interface TfClient {
  createSession(agent: string): Promise<string>;
  streamTurn(sessionId: string, content: string, signal?: AbortSignal): AsyncIterable<TfEvent>;
  approve(a: { sessionId: string; turnId: string; threadId: string; toolCallId: string; allow: boolean; reason?: string; afterEventId: string; signal?: AbortSignal }): AsyncIterable<TfEvent>;
  cancel(sessionId: string): Promise<void>;
  sessionUrl(sessionId: string): string;
  ping(): Promise<boolean>;
}

type AnyEvent = { type: string; id?: string; [k: string]: unknown };

/** Wraps a raw SDK stream: merges deltas into per-id messages, yields all events. */
async function* withMerge(stream: AsyncIterable<unknown>): AsyncIterable<TfEvent> {
  const synthetic = new Map<string, AnyEvent>();   // messages seen only as deltas
  const real = new Set<string>();                   // ids of real model.message events seen
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
      real.add(ev.id);
    }
    if (ev.type === 'tool.approval_required') {
      const refs = (ev.toolCalls as Array<{ sourceEventId: string }> | undefined) ?? [];
      for (const r of refs) {
        const s = synthetic.get(r.sourceEventId);
        if (s && !real.has(r.sourceEventId)) {
          real.add(r.sourceEventId);
          yield s as TfEvent;
        }
      }
    }
    yield ev as TfEvent;
  }
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
