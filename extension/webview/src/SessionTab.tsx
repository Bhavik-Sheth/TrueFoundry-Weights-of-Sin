import { useEffect, useState } from 'react';
import type { TimelineEntry, SessionSummary, SessionView, TurnView } from '../../src/types';
import { post, subscribe } from './bridge';
import { MessageBody } from './MessageBody';

interface SessionState { sessions: SessionView[]; recent: SessionSummary[]; selected: string[]; error?: string; loaded: boolean }
let state: SessionState = { sessions: [], recent: [], selected: [], loaded: false };
const listeners = new Set<() => void>();
let trueForgeUrl = '';
subscribe(message => {
  if (message.type === 'session') { trueForgeUrl = message.url; listeners.forEach(listener => listener()); return; }
  if (message.type !== 'sessionView') return;
  state = { sessions: message.sessions, recent: message.recent, selected: message.selected, error: message.error, loaded: true };
  listeners.forEach(listener => listener());
});

const terminal = new Set(['done', 'cancelled', 'error', 'failed']);
const filters = ['All', 'Tools', 'Messages', 'Approvals'] as const;
type Filter = typeof filters[number];
const number = (n?: number) => n === undefined ? '—' : n.toLocaleString();
const duration = (ms?: number) => ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};
const group = (entry: TimelineEntry): Filter =>
  entry.kind === 'tool' ? 'Tools' : entry.kind === 'approval' ? 'Approvals' :
  entry.kind === 'user' || entry.kind === 'model' ? 'Messages' : 'All';

function readableStatus(status: string) {
  if (status === 'done') return 'Completed';
  if (status === 'requested') return 'Requested';
  return status.replace(/[_-]/g, ' ');
}

function titleFor(tool: string) {
  const labels: Record<string, string> = {
    assemble_context: 'Build context', file_context: 'Inspect file history', resume_context: 'Restore context checkpoint',
    read_file: 'Read source', search_workspace: 'Search workspace', list_symbols: 'List symbols',
    propose_write: 'Propose edits', run_command: 'Run command',
  };
  return labels[tool] ?? tool;
}

function displayJson(value: unknown) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? '';
}

function toolTarget(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const args = value as Record<string, unknown>;
  if (typeof args.path !== 'string') return;
  const lines = typeof args.startLine === 'number' ? `:${args.startLine}${typeof args.endLine === 'number' ? `–${args.endLine}` : ''}` : '';
  return args.path + lines;
}

function Entry({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case 'user':
      return <article className="session-message"><strong>Request</strong><MessageBody text={entry.text} /></article>;
    case 'model':
      return <details className="activity-entry">
        <summary className="activity-heading">
          <span className="activity-name">Model response</span>
          {entry.inputTokens !== undefined && <span className="activity-meta">{number(entry.inputTokens)} in · {number(entry.outputTokens)} out</span>}
        </summary>
        <div className="activity-details">
          <p className="muted">{[entry.model, entry.finishReason, entry.threadId !== 'main' ? entry.threadId : undefined].filter(Boolean).join(' · ')}</p>
          {entry.text ? <MessageBody text={entry.text} /> : <p className="muted">This response returned tool actions.</p>}
        </div>
      </details>;
    case 'tool': {
      const target = toolTarget(entry.args);
      return <details className="activity-entry">
        <summary className="activity-heading">
          <span className="activity-name">{titleFor(entry.name)}</span>
          <span className="activity-meta">{entry.result === undefined ? 'Pending' : 'Result'}{entry.deferred && ' · on demand'}</span>
          {target && <span className="activity-target">{target}</span>}
        </summary>
        <div className="activity-details">
          <p className="muted"><code>{entry.name}</code>{entry.server && ` · MCP ${entry.server}`}{entry.threadId !== 'main' && ` · ${entry.threadId}`}</p>
          {entry.args !== undefined && <div className="activity-detail"><span>Input</span><pre>{displayJson(entry.args)}</pre></div>}
          {entry.result !== undefined && <div className="activity-detail"><span>Result</span><pre>{displayJson(entry.result)}</pre></div>}
        </div>
      </details>;
    }
    case 'approval':
      return <div className="activity-notice">
        <span className="activity-name">{titleFor(entry.name)}</span>
        <span className={entry.status === 'denied' ? 'err' : entry.status === 'allowed' ? 'ok' : 'warn'}>
          {entry.status === 'requested' ? 'Approval requested' : `Approval ${entry.status}`}
        </span>
        {entry.reason && <span className="muted">{entry.reason}</span>}
      </div>;
    case 'thread':
      return <details className="activity-entry">
        <summary className="activity-heading"><span className="activity-name">{entry.title}</span>
          <span className="activity-meta">Subagent · {readableStatus(entry.status)}</span></summary>
        <div className="activity-details">
          <p className="muted">{[entry.agent, entry.model, entry.threadId].filter(Boolean).join(' · ')}</p>
          {entry.error && <p className="err">{entry.error}</p>}
        </div>
      </details>;
    case 'turn-done':
      return entry.error ? <p className="err" role="alert">{entry.error}</p> : null;
    case 'info':
      return <p className="muted session-info">{entry.text}</p>;
  }
}

function SessionTurn({ turn, filter }: { turn: TurnView; filter: Filter }) {
  const [limit, setLimit] = useState(30);
  const entries = turn.entries.filter(entry => filter === 'All' || group(entry) === filter);
  return <>
    <dl className="session-metrics session-usage">
      <div><dt>Status</dt><dd className={['error', 'failed'].includes(turn.status) ? 'err' : undefined}>{readableStatus(turn.status)}</dd></div>
      <div><dt>Duration</dt><dd>{duration(turn.durationMs)}</dd></div>
      <div><dt>Input</dt><dd>{number(turn.inputTokens)}</dd></div>
      <div><dt>Output</dt><dd>{number(turn.outputTokens)}</dd></div>
    </dl>
    {turn.error && !entries.some(entry => entry.kind === 'turn-done' && entry.error) && <p className="err" role="alert">{turn.error}</p>}
    {!entries.length && <p className="muted">No {filter === 'All' ? 'activity' : filter.toLowerCase()} in this turn.</p>}
    <div className="session-timeline">
      {entries.length > limit && <button type="button" className="inline-action" onClick={() => setLimit(limit + 30)}>
        Show earlier activity ({entries.length - limit})
      </button>}
      {entries.slice(-limit).map((entry, index) => <Entry key={entry.kind === 'tool' ? entry.toolCallId : entry.kind === 'model' || entry.kind === 'user' ? entry.id : index} entry={entry} />)}
    </div>
  </>;
}

export function SessionTab({ onViewContext }: { onViewContext: () => void }) {
  const [st, setSt] = useState(state);
  const [url, setUrl] = useState(trueForgeUrl);
  const [sessionId, setSessionId] = useState('');
  const [turnId, setTurnId] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  useEffect(() => {
    const listener = () => { setSt(state); setUrl(trueForgeUrl); };
    listeners.add(listener);
    listener();
    post({ type: 'sessionLoad' });
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (!st.loaded || st.error || !st.sessions.some(session => !session.sealed &&
      session.turns.some(turn => !terminal.has(turn.status)))) return;
    const timer = window.setTimeout(() => post({ type: 'sessionLoad', sessionIds: st.selected }), 3000);
    return () => window.clearTimeout(timer);
  }, [st]);

  const current = st.recent.some(r => r.id === st.selected[0]) ? st.selected[0] : '';
  const session = st.sessions.find(item => item.id === sessionId) ?? st.sessions.find(item => !item.sealed) ?? st.sessions[0];
  const turn = session?.turns.find(item => item.id === turnId) ?? session?.turns.at(-1);
  const load = (id: string) => {
    setSessionId('');
    setTurnId('');
    post(id ? { type: 'sessionLoad', sessionIds: [id] } : { type: 'sessionLoad' });
  };

  return <section className="session-explorer" aria-label="Session explorer">
    <div className="session-toolbar">
      <label htmlFor="run-picker">Session</label>
      <div className="control-row">
        <select id="run-picker" value={current} onChange={event => load(event.target.value)}>
          <option value="">Current run</option>
          {st.recent.map(item => <option key={item.id} value={item.id}>
            {item.title ?? item.agent} · {when(item.createdAt)}
          </option>)}
        </select>
        <button className="btn secondary" type="button" onClick={() => post(current ? { type: 'sessionLoad', sessionIds: [current] } : { type: 'sessionLoad' })}>Refresh</button>
      </div>
    </div>
    {st.error && <p className="err" role="alert">{st.error}</p>}
    {!st.loaded && <p className="muted" role="status">Loading sessions…</p>}
    {st.loaded && !st.error && !session && <p className="muted">Start a chat or choose a recent session.</p>}
    {session && <>
      <header className="session-header">
        <div><strong>{session.agent}</strong><div className="muted">{session.model ?? 'Model unavailable'}</div></div>
        {!current && <button className="inline-action" type="button" onClick={onViewContext}>View context</button>}
        {url && <button className="inline-action" type="button" onClick={() => post({ type: 'openTrueForge' })}>Open in TrueForge</button>}
      </header>
      {st.sessions.length > 1 && <label className="session-field">Run session
        <select aria-label="Run session" value={session.id} onChange={event => { setSessionId(event.target.value); setTurnId(''); }}>
          {st.sessions.map(item => <option key={item.id} value={item.id}>{item.agent} · {item.role}{item.sealed ? ' · closed' : ''}</option>)}
        </select>
      </label>}
      {turn ? <>
        <label className="session-field">Turn
          <select aria-label="Turn" value={turn.id} onChange={event => setTurnId(event.target.value)}>
            {session.turns.map((item, index) => <option key={item.id} value={item.id}>Turn {index + 1} · {readableStatus(item.status)}</option>)}
          </select>
        </label>
        <div className="filter-bar" role="group" aria-label="Filter activity">
          {filters.map(item => <button type="button" key={item} aria-pressed={item === filter} onClick={() => setFilter(item)}>
            {item}{item !== 'All' && <span>{turn.entries.filter(entry => group(entry) === item).length}</span>}
          </button>)}
        </div>
        <SessionTurn key={`${turn.id}:${filter}`} turn={turn} filter={filter} />
      </> : <p className="muted">This session has no recorded turns.</p>}
      <details className="session-metadata">
        <summary>Session details</summary>
        <dl>
          <dt>Session ID</dt><dd><code>{session.id}</code></dd>
          <dt>Started</dt><dd>{when(session.createdAt)}</dd>
          <dt>Route</dt><dd>{session.role}{session.sealed && ' · closed'}</dd>
          {turn && <><dt>Turn ID</dt><dd><code>{turn.id}</code></dd></>}
          {turn?.costUsd !== undefined && <><dt>Estimated cost</dt><dd>${turn.costUsd.toFixed(4)}</dd></>}
        </dl>
      </details>
    </>}
    <details className="session-metadata">
      <summary>Trace actions</summary>
      <div className="control-row">
        <button className="btn secondary" type="button" onClick={() => post({ type: 'reviewAction', action: 'replay' })}>Replay run</button>
        <button className="btn secondary" type="button" onClick={() => post({ type: 'reviewAction', action: 'import' })}>Import trace</button>
      </div>
    </details>
  </section>;
}
