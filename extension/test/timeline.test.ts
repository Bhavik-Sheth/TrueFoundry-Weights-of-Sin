/**
 * timeline.test.ts - Session tab mapping from a recorded-style event list (tool call, deferred call, approval,
 * subagent thread, error) plus delta merging of stored events.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/log', () => ({ log: () => {} }));
import { buildSessionView, buildTurnView, describeCall } from '../src/run/timeline';
import { mergeStoredDeltas, withMerge } from '../src/run/tfClient';

const mcpInfo = (name: string) => ({ type: 'mcp', name, serverId: 'contexo-editor', serverName: 'contexo-editor' });
const call = (id: string, name: string, args: unknown, toolInfo: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, toolInfo });

const turn = {
  id: 'turn_1', sessionId: 's1', previousTurnId: null, createdAt: '2026-01-01T00:00:00.000Z',
  input: [{ type: 'user.message', content: 'add a command' }],
  state: { status: 'done', completedAt: '2026-01-01T00:00:03.500Z' },
};

const events = [
  { type: 'turn.created', id: 'e0', turnId: 'turn_1', input: turn.input },
  { type: 'model.message', id: 'm1', threadId: 'main', model: { name: 'fake/m' }, content: 'Looking.', usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [call('c1', 'read_file', { path: 'a.py' }, mcpInfo('read_file'))] },
  { type: 'tool.response', id: 'e2', threadId: 'main', toolCallId: 'c1', content: 'file text' },
  { type: 'model.message', id: 'm2', threadId: 'main', content: '', usage: { inputTokens: 20, outputTokens: 6 },
    toolCalls: [call('c2', 'call_tool', { mcp_server: 'contexo-editor', tool_name: 'list_symbols', arguments: {} }, { type: 'truefoundry-system', name: 'call_tool' })] },
  { type: 'tool.response', id: 'e4', threadId: 'main', toolCallId: 'c2', content: '[]' },
  { type: 'thread.created', id: 'e5', threadId: 't_sub', parent: { threadId: 'main', toolCallId: 'c9' }, title: 'researcher', agentInfo: { type: 'dynamic', name: 'researcher', model: 'fake/m', input: 'dig' } },
  { type: 'model.message', id: 'm3', threadId: 't_sub', content: 'sub says hi' },
  { type: 'thread.done', id: 'e7', threadId: 't_sub', title: 'researcher', state: { status: 'error', error: 'sub failed' } },
  { type: 'model.message', id: 'm4', threadId: 'main', content: '',
    toolCalls: [call('c3', 'propose_write', { summary: 's', edits: [] }, mcpInfo('propose_write'))] },
  { type: 'tool.approval_required', id: 'e9', threadId: 'main', toolCalls: [{ id: 'c3', sourceEventId: 'm4' }] },
  { type: 'user.tool_approval', id: 'e10', threadId: 'main', toolCallId: 'c3', approval: { status: 'deny', reason: 'user rejected' } },
  { type: 'tool.response', id: 'e11', threadId: 'main', toolCallId: 'c3', content: 'denied' },
  { type: 'turn.done', id: 'e12', state: { status: 'done', completedAt: '2026-01-01T00:00:03.500Z', metrics: { totalInputTokens: 30, totalOutputTokens: 11, totalTokens: 41 } } },
];

describe('buildTurnView', () => {
  const v = buildTurnView(turn, events);
  it('maps status, timing and token metrics', () => {
    expect(v.status).toBe('done');
    expect(v.durationMs).toBe(3500);
    expect([v.inputTokens, v.outputTokens, v.totalTokens]).toEqual([30, 11, 41]);
  });
  it('starts with the user message and ends with turn.done', () => {
    expect(v.entries[0]).toMatchObject({ kind: 'user', text: 'add a command' });
    expect(v.entries.at(-1)).toMatchObject({ kind: 'turn-done', status: 'done' });
  });
  it('maps a direct MCP tool call with server and result', () => {
    expect(v.entries.find((e) => e.kind === 'tool' && e.toolCallId === 'c1')).toMatchObject({ name: 'read_file', server: 'contexo-editor', deferred: false, result: 'file text', args: { path: 'a.py' } });
  });
  it('marks call_tool as deferred and unwraps the real tool name and server', () => {
    expect(v.entries.find((e) => e.kind === 'tool' && e.toolCallId === 'c2')).toMatchObject({ name: 'list_symbols', server: 'contexo-editor', deferred: true });
  });
  it('records the approval with the deny decision and reason, named from its source message', () => {
    const a = v.entries.filter((e) => e.kind === 'approval');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ toolCallId: 'c3', name: 'propose_write', status: 'denied', reason: 'user rejected' });
  });
  it('shows the subagent thread with parent link and error status; its messages carry the thread id', () => {
    expect(v.entries.find((e) => e.kind === 'thread')).toMatchObject({ threadId: 't_sub', parentThreadId: 'main', parentToolCallId: 'c9', status: 'error', error: 'sub failed' });
    expect(v.entries.find((e) => e.kind === 'model' && e.id === 'm3')).toMatchObject({ threadId: 't_sub', text: 'sub says hi' });
  });
  it('does not emit empty model entries for tool-only messages', () => {
    expect(v.entries.some((e) => e.kind === 'model' && e.id === 'm2')).toBe(false);
  });
});

describe('error shapes', () => {
  it('turn.done error: status, message and the turn-done entry', () => {
    const msg = '[Model Error] Cannot connect to API: bad port';
    const v = buildTurnView({ ...turn, state: { status: 'error' } }, [{ type: 'turn.done', id: 'x', state: { status: 'error', message: msg, completedAt: '2026-01-01T00:00:00.100Z' } }]);
    expect(v.status).toBe('error');
    expect(v.error).toBe(msg);
    expect(v.entries.at(-1)).toMatchObject({ kind: 'turn-done', status: 'error', error: msg });
  });
  it('cancelled turns keep the reason; a running turn has no turn-done entry', () => {
    const c = buildTurnView({ ...turn, state: { status: 'cancelled', reason: 'client-cancelled' } }, [{ type: 'turn.done', id: 'x', state: { status: 'cancelled', reason: 'client-cancelled' } }]);
    expect(c.entries.at(-1)).toMatchObject({ kind: 'turn-done', status: 'cancelled', reason: 'client-cancelled' });
    expect(buildTurnView({ ...turn, state: { status: 'running' } }, []).entries.some((e) => e.kind === 'turn-done')).toBe(false);
  });
  it('sums per-message usage when the turn has no metrics', () => {
    const v = buildTurnView({ ...turn, state: { status: 'running' } }, events.slice(0, 5));
    expect([v.inputTokens, v.outputTokens]).toEqual([30, 11]);
  });
});

describe('buildSessionView', () => {
  const ctx = { primaryAgent: 'contexo', fallbackAgent: 'contexo-fallback' };
  it('names the agent, takes the model from the first model message and tags the role', () => {
    const t = buildTurnView(turn, events);
    const primary = buildSessionView({ id: 's1', createdAt: 'x', title: null, agent: { type: 'reference', id: 'a', name: 'contexo' } }, [t], { ...ctx, sealed: true });
    expect(primary).toMatchObject({ agent: 'contexo', role: 'primary', sealed: true, model: 'fake/m' });
    const fb = buildSessionView({ id: 's2', createdAt: 'x', title: 'T', agent: { type: 'reference', id: 'b', name: 'contexo-fallback' } }, [], { ...ctx, sealed: false });
    expect(fb).toMatchObject({ role: 'fallback', title: 'T', sealed: false });
  });
});

describe('describeCall / mergeStoredDeltas', () => {
  it('tolerates unparsable arguments', () => {
    expect(describeCall({ function: { name: 'x', arguments: '{oops' } }).args).toBe('{oops');
  });
  it('merges deltas into one model.message and keeps already-complete messages', () => {
    const out = mergeStoredDeltas([
      { type: 'model.message.delta', id: 'a', threadId: 'main', content: 'Hel' },
      { type: 'model.message.delta', id: 'a', threadId: 'main', content: 'lo' },
      { type: 'model.message', id: 'b', threadId: 'main', content: 'done' },
    ]);
    expect(out.map((e: { type: string }) => e.type)).toEqual(['model.message', 'model.message']);
    expect(out[0].content).toBe('Hello');
    expect(out[1].content).toBe('done');
  });
});

describe('withMerge (live stream shape: empty placeholder message, then deltas)', () => {
  it('yields the merged message with tool calls before tool.approval_required', async () => {
    async function* src() {
      yield { type: 'model.message', id: 'm', threadId: 'main' };
      yield { type: 'model.message.delta', id: 'm', threadId: 'main', toolCalls: [{ toolInfo: { type: 'mcp', name: 'propose_write', serverId: 's', serverName: 's' }, index: 0, id: 'c1', type: 'function', function: { name: 'propose_write', arguments: '' } }] };
      yield { type: 'model.message.delta', id: 'm', threadId: 'main', toolCalls: [{ index: 0, function: { arguments: '{"a":1}' } }] };
      yield { type: 'tool.approval_required', id: 'ap', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm' }] };
    }
    const out: Array<{ type: string; id?: string; toolCalls?: Array<{ function: { name: string; arguments: string } }> }> = [];
    for await (const e of withMerge(src())) out.push(e as never);
    const iApproval = out.findIndex((e) => e.type === 'tool.approval_required');
    const merged = out.slice(0, iApproval).filter((e) => e.type === 'model.message').at(-1)!;
    expect(merged.toolCalls?.[0].function).toMatchObject({ name: 'propose_write', arguments: '{"a":1}' });
  });
});
