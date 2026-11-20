/**
 * run/timeline.ts - pure mapping of a TrueForge turn (turn object + its persisted events) to the display
 * model of the Session tab. No vscode, no SDK import: events are read as loose camelCase objects.
 *
 * Exports: describeCall(toolCall), buildTurnView(turn, events), buildSessionView(session, turnViews, ctx).
 * Depends on: types. Depended on by: run/tfClient (inspector), tests.
 */
import type { SessionView, TimelineEntry, TurnView } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const RESULT_MAX = 2000;
const TEXT_MAX = 4000;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}... (${s.length} chars)` : s;
}

/** Text of a model message / user message content (string or array of text parts). */
export function contentText(c: Any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : String(p?.text ?? p?.refusal ?? ''))).join('');
  return '';
}

/**
 * A model tool call -> name/args/server. Deferred tools go through TrueForge's `call_tool` wrapper
 * (arguments: mcp_server, tool_name, ...); the server for a direct MCP call is toolInfo.serverName.
 */
export function describeCall(tc: Any): { name: string; args: unknown; server?: string; deferred: boolean } {
  const fn = tc?.function ?? {};
  let args: Any;
  try { args = JSON.parse(fn.arguments ?? '{}'); } catch { args = fn.arguments; }
  const info = tc?.toolInfo;
  if (fn.name === 'call_tool' && args && typeof args === 'object' && args.tool_name) {
    return { name: String(args.tool_name), args, server: typeof args.mcp_server === 'string' ? args.mcp_server : info?.serverName, deferred: true };
  }
  return { name: String(fn.name ?? 'unknown'), args, server: info?.type === 'mcp' ? String(info.serverName) : undefined, deferred: false };
}

/** Builds one TurnView. `events` must be in chronological order (deltas already merged by the caller). */
export function buildTurnView(turn: Any, events: Any[]): TurnView {
  const entries: TimelineEntry[] = [];
  const toolIdx = new Map<string, Extract<TimelineEntry, { kind: 'tool' }>>();
  const apprIdx = new Map<string, Extract<TimelineEntry, { kind: 'approval' }>>();
  const threadIdx = new Map<string, Extract<TimelineEntry, { kind: 'thread' }>>();
  const callNames = new Map<string, string>();
  let sumIn = 0;
  let sumOut = 0;
  let sawUsage = false;
  let doneState: Any;

  const inputs: Any[] = Array.isArray(turn?.input) && turn.input.length
    ? turn.input
    : (events.find((e) => e.type === 'turn.created')?.input ?? []);
  for (const it of inputs) {
    if (it?.type === 'user.message') entries.push({ kind: 'user', id: `${turn.id}-in-${entries.length}`, text: clip(contentText(it.content), TEXT_MAX) });
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'model.message': {
        const text = contentText(ev.content);
        const usage = ev.usage;
        if (usage) { sawUsage = true; sumIn += usage.inputTokens ?? 0; sumOut += usage.outputTokens ?? 0; }
        const calls: Any[] = ev.toolCalls ?? [];
        if (text || !calls.length) {
          entries.push({
            kind: 'model', id: ev.id, threadId: ev.threadId ?? 'main', text: clip(text, TEXT_MAX),
            model: ev.model?.name, finishReason: ev.finishReason ?? undefined,
            inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
          });
        }
        for (const tc of calls) {
          const d = describeCall(tc);
          const t: Extract<TimelineEntry, { kind: 'tool' }> = {
            kind: 'tool', toolCallId: tc.id, threadId: ev.threadId ?? 'main', name: d.name, server: d.server, deferred: d.deferred, args: d.args,
          };
          toolIdx.set(tc.id, t);
          callNames.set(tc.id, d.name);
          entries.push(t);
        }
        break;
      }
      case 'tool.response': {
        const t = toolIdx.get(ev.toolCallId);
        if (t) t.result = clip(String(ev.content ?? ''), RESULT_MAX);
        break;
      }
      case 'tool.approval_required': {
        for (const ref of (ev.toolCalls ?? []) as Any[]) {
          const a: Extract<TimelineEntry, { kind: 'approval' }> = {
            kind: 'approval', toolCallId: ref.id, threadId: ev.threadId ?? 'main', name: callNames.get(ref.id) ?? 'unknown', status: 'requested',
          };
          apprIdx.set(ref.id, a);
          entries.push(a);
        }
        break;
      }
      case 'user.tool_approval': {
        const a = apprIdx.get(ev.toolCallId);
        const allow = ev.approval?.status === 'allow';
        if (a) {
          a.status = allow ? 'allowed' : 'denied';
          if (!allow && ev.approval?.reason) a.reason = String(ev.approval.reason);
        } else {
          entries.push({ kind: 'approval', toolCallId: ev.toolCallId, threadId: ev.threadId ?? 'main', name: callNames.get(ev.toolCallId) ?? 'unknown', status: allow ? 'allowed' : 'denied', reason: ev.approval?.reason });
        }
        break;
      }
      case 'thread.created': {
        const th: Extract<TimelineEntry, { kind: 'thread' }> = {
          kind: 'thread', threadId: ev.threadId, parentThreadId: ev.parent?.threadId, parentToolCallId: ev.parent?.toolCallId,
          title: String(ev.title ?? ev.agentInfo?.name ?? 'subagent'), agent: ev.agentInfo?.name, model: ev.agentInfo?.model, status: 'running',
        };
        threadIdx.set(ev.threadId, th);
        entries.push(th);
        break;
      }
      case 'thread.done': {
        const th = threadIdx.get(ev.threadId);
        const err = ev.state?.status === 'error';
        if (th) { th.status = err ? 'error' : 'done'; if (err) th.error = String(ev.state.error ?? ''); }
        break;
      }
      case 'turn.done':
        doneState = ev.state;
        break;
      default:
        break;
    }
  }

  const st = doneState ?? turn?.state ?? {};
  const status = String(st.status ?? 'unknown');
  const error = status === 'error' ? String(st.message ?? 'turn error') : undefined;
  if (doneState) {
    entries.push({ kind: 'turn-done', status, error, reason: status === 'cancelled' ? String(st.reason ?? '') || undefined : undefined });
  }
  const m = st.metrics ?? {};
  const completedAt: string | undefined = st.completedAt;
  const t0 = Date.parse(turn?.createdAt ?? '');
  const t1 = completedAt ? Date.parse(completedAt) : NaN;
  return {
    id: turn.id,
    status,
    createdAt: turn.createdAt,
    completedAt,
    durationMs: Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : undefined,
    inputTokens: m.totalInputTokens ?? (sawUsage ? sumIn : undefined),
    outputTokens: m.totalOutputTokens ?? (sawUsage ? sumOut : undefined),
    totalTokens: m.totalTokens ?? (sawUsage ? sumIn + sumOut : undefined),
    costUsd: m.totalCostInUsd,
    error,
    entries,
  };
}

/** Assembles a SessionView from the SDK session object and its built turns. */
export function buildSessionView(
  session: Any,
  turns: TurnView[],
  ctx: { primaryAgent: string; fallbackAgent: string; sealed: boolean },
): SessionView {
  const a = session?.agent;
  const agent: string = a?.type === 'reference' ? String(a.name ?? a.id) : a?.type === 'inline' ? String(a.spec?.name ?? 'inline agent') : 'unknown';
  let model: string | undefined = a?.type === 'inline' ? a.spec?.manifest?.model?.name ?? a.spec?.model?.name : undefined;
  for (const t of turns) {
    for (const e of t.entries) if (!model && e.kind === 'model' && e.model) model = e.model;
  }
  return {
    id: session.id,
    agent,
    model,
    title: session.title ?? undefined,
    createdAt: session.createdAt,
    role: agent === ctx.primaryAgent ? 'primary' : agent === ctx.fallbackAgent ? 'fallback' : 'other',
    sealed: ctx.sealed,
    turns,
  };
}
