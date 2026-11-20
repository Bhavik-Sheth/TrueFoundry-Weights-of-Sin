/**
 * run/fallback.ts - C2 failure classification and automatic fallback (Slice 8).
 *
 * Exports:
 *  - classifyDetailed(x, ctx?): {kind, reason, trueforgeDown}. kind = 'model-failure' for HTTP
 *    401/403/404/408/429/5xx (SDK TrueForgeError.statusCode), SDK timeouts, Node network codes
 *    (ECONNREFUSED/ENOTFOUND/ETIMEDOUT/ECONNRESET/'fetch failed', searched along the cause chain),
 *    and turn.done {state:{status:'error', message}} whose message matches provider/auth/model/
 *    endpoint patterns. 'cancelled' for turn.done status 'cancelled' / abort errors. Everything
 *    else (tool errors, unmatched text) is 'other'.
 *    trueforgeDown = a THROWN network-level error (no HTTP status) before any model activity
 *    (ctx.sawActivity falsy): TrueForge itself cannot be reached, so fallback cannot help.
 *  - classify(x): thin wrapper returning only kind.
 *  - FallbackDeps, takeOver(run, deps): once per run; seals the primary session, discards the
 *    pending proposal, creates a fallback session, emits session + state(banner) and replays the
 *    original first message with a note.
 *
 * Rules: classify is pure (no vscode import); workspace untouched.
 * Depends on: run/tfClient (type), config (type), types. Depended on by: run/runManager.
 */
import type { Run, RunStateMsg } from '../types';
import type { TfClient } from './tfClient';
import type { ContexoConfig } from '../config';

export type FailureKind = 'model-failure' | 'cancelled' | 'other';
export interface Classification { kind: FailureKind; reason: string; trueforgeDown: boolean }
export interface ClassifyCtx { sawActivity?: boolean }

const NET_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'];
const TEXT_RE = /\b(401|403|404|408|429)\b|\b5\d\d\b|unauthori[sz]ed|forbidden|invalid.*key|api[ _-]?key|authentication|not found|rate.?limit|quota|overloaded|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|timed? ?out|model|provider|endpoint/i;
const FAIL_STATUS = (s: number) => s === 401 || s === 403 || s === 404 || s === 408 || s === 429 || (s >= 500 && s <= 599);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function firstLine(s: string, max = 120): string {
  const friendly = explainModelError(s);
  if (friendly) return friendly;
  const l = s.split('\n')[0].trim();
  return l.length > max ? `${l.slice(0, max - 1)}...` : l;
}

/** Plain-language reason for common provider errors, or undefined when the raw message is clear enough. */
export function explainModelError(msg: string): string | undefined {
  if (/support(s)? tool use|tool use is not supported|does not support tools|tools? (are|is) not supported|function calling is not supported/i.test(msg)) {
    return 'the model does not support tool calling, which Contexo needs. Pick a chat model with tool support (on OpenRouter, filter models by "Tools")';
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
    return 'the provider is rate-limiting requests (free models have low limits). Wait a minute or pick another model';
  }
  if (/\b402\b|insufficient (credits|balance|quota)|payment required/i.test(msg)) {
    return 'the provider account has no credits left for this model';
  }
  if (/model.{0,40}not (found|exist)|no such model|invalid model/i.test(msg)) {
    return 'the provider does not know this model id. Check the model name';
  }
  return undefined;
}

/** Walks error -> cause chain (max 5) looking for a Node network code or 'fetch failed'. */
function networkReason(e: Any): string | undefined {
  let fetchFailed = false;
  let cur = e;
  for (let i = 0; i < 5 && cur; i++, cur = cur.cause) {
    if (typeof cur.code === 'string' && NET_CODES.includes(cur.code)) return cur.code;
    if (typeof cur.message === 'string') {
      const m = NET_CODES.find((c) => cur.message.includes(c));
      if (m) return m;
      if (/fetch failed/i.test(cur.message)) fetchFailed = true;
    }
  }
  return fetchFailed ? 'fetch failed' : undefined;
}

export function classifyDetailed(x: unknown, ctx: ClassifyCtx = {}): Classification {
  const o = x as Any;
  if (o == null) return { kind: 'other', reason: 'unknown error', trueforgeDown: false };

  // turn.done events (or a bare state object)
  const st = o.type === 'turn.done' ? o.state : o.status !== undefined && o.message !== undefined && !(o instanceof Error) ? o : undefined;
  if (st) {
    if (st.status === 'cancelled') return { kind: 'cancelled', reason: 'cancelled', trueforgeDown: false };
    if (st.status === 'error') {
      const msg = String(st.message ?? 'turn error');
      if (/\[MCP Error\]|failed to connect to remote MCP server/i.test(msg)) {
        return { kind: 'other', reason: firstLine(msg), trueforgeDown: false };
      }
      return { kind: TEXT_RE.test(msg) ? 'model-failure' : 'other', reason: firstLine(msg), trueforgeDown: false };
    }
    return { kind: 'other', reason: `turn ${String(st.status)}`, trueforgeDown: false };
  }

  // Tool errors are never a model failure.
  if (o.type === 'tool.response' || o.type === 'tool.error') {
    return { kind: 'other', reason: 'tool error', trueforgeDown: false };
  }

  // Thrown errors
  if (o.name === 'AbortError' || o.name === 'CancelledError') return { kind: 'cancelled', reason: 'aborted', trueforgeDown: false };
  const status = typeof o.statusCode === 'number' ? o.statusCode : typeof o.status === 'number' ? o.status : undefined;
  if (status !== undefined) {
    return FAIL_STATUS(status)
      ? { kind: 'model-failure', reason: `HTTP ${status}`, trueforgeDown: false }
      : { kind: 'other', reason: `HTTP ${status}`, trueforgeDown: false };
  }
  const net = networkReason(o);
  if (net) return { kind: 'model-failure', reason: net, trueforgeDown: !ctx.sawActivity };
  if (o.name === 'TrueForgeTimeoutError') return { kind: 'model-failure', reason: 'request timed out', trueforgeDown: false };
  const msg = String(o.message ?? o);
  return { kind: TEXT_RE.test(msg) ? 'model-failure' : 'other', reason: firstLine(msg), trueforgeDown: false };
}

export function classify(x: unknown): FailureKind {
  return classifyDetailed(x).kind;
}

export interface FallbackDeps {
  tf: TfClient;
  cfg: ContexoConfig;
  /** Short reason the primary failed (shown in the banner). */
  reason: string;
  /** The original first message of the run, replayed on the fallback. */
  firstMessage: string;
  /** Drops pending approvals / per-turn state and calls review.discardPending(). */
  reset: () => void;
  emitSession: (info: { sessionId: string; agent: string; url: string }) => void;
  emitState: (m: RunStateMsg) => void;
  /** Runs one turn (abort controller, first-event timer, consume) on run.sessionId. */
  runTurn: (run: Run, content: string) => Promise<void>;
}

export const FALLBACK_NOTE = '[Note] The previous model failed before finishing; continue the same task from the start.';

export async function takeOver(run: Run, deps: FallbackDeps): Promise<void> {
  const { cfg, tf } = deps;
  if (run.agent === 'contexo-fallback' || run.agent === (cfg.fallbackAgent as Run['agent'])) {
    throw new Error('fallback already used for this run');
  }
  run.sealedSessions.push(run.sessionId);
  deps.reset();
  const agent = cfg.fallbackAgent;
  const sessionId = await tf.createSession(agent);
  if (run.state === 'cancelled') return;
  run.sessionId = sessionId;
  run.agent = agent as Run['agent'];
  deps.emitSession({ sessionId, agent, url: tf.sessionUrl(sessionId) });
  const short = deps.reason.length > 80 ? `${deps.reason.slice(0, 79)}...` : deps.reason;
  deps.emitState({
    state: 'streaming', agent,
    banner: `Primary model failed (${short}). Continued on fallback ${agent}.`,
  });
  await deps.runTurn(run, `${deps.firstMessage}\n\n${FALLBACK_NOTE}`);
}
