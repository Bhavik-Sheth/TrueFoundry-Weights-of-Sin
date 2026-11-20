/**
 * SessionTab.tsx - Session tab: read-only view of the TrueForge session(s) of the current run (or any recent
 * session), built by the host from TrueForge's API (no iframe). Host counterpart: src/shell/sessionController.ts.
 *
 * Exports:
 *  - SessionTab (React component): picker (current run / recent sessions), Refresh button, one block per session
 *    (id, agent, model, primary/fallback + sealed badges) with its turns (status, timing, tokens) and an ordered
 *    timeline: user message, model messages (collapsed), tool calls (name, MCP server, deferred marker, args,
 *    result), approvals (requested/allowed/denied), subagent threads, turn.done status/error.
 *  - State lives at module level so it survives tab switches; the host re-pushes on every turn end.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SessionSummary, SessionView, TimelineEntry, TurnView } from '../../src/types';
import { post, subscribe } from './bridge';

interface SessionState { sessions: SessionView[]; recent: SessionSummary[]; selected: string[]; error?: string; loaded: boolean }
let state: SessionState = { sessions: [], recent: [], selected: [], loaded: false };
const listeners = new Set<() => void>();
subscribe((m) => {
  if (m.type === 'sessionView') {
    state = { sessions: m.sessions, recent: m.recent, selected: m.selected, error: m.error, loaded: true };
    listeners.forEach((l) => l());
  }
});

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8 },
  muted: { color: 'var(--vscode-descriptionForeground)', fontSize: 12 },
  chip: { display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', marginRight: 6 },
  badge: { padding: '0 6px', borderRadius: 8, fontSize: 10, border: '1px solid var(--vscode-focusBorder)', marginLeft: 6 },
  box: { border: '1px solid var(--vscode-panel-border)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 },
  pre: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', fontSize: 11, background: 'var(--vscode-textCodeBlock-background)', padding: 6 },
  err: { color: 'var(--vscode-errorForeground)' },
};
const statusColor: Record<string, string> = {
  done: 'var(--vscode-testing-iconPassed)', error: 'var(--vscode-errorForeground)', cancelled: 'var(--vscode-editorWarning-foreground)',
  allowed: 'var(--vscode-testing-iconPassed)', denied: 'var(--vscode-errorForeground)', requested: 'var(--vscode-editorWarning-foreground)',
};

const json = (v: unknown) => { try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); } };
const secs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

function Entry({ e }: { e: TimelineEntry }) {
  switch (e.kind) {
    case 'user':
      return <div><span style={s.chip}>user</span><span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.text}</span></div>;
    case 'model': {
      const usage = e.inputTokens !== undefined ? ` · ${e.inputTokens} in / ${e.outputTokens ?? 0} out` : '';
      return (
        <details>
          <summary><span style={s.chip}>model{e.threadId !== 'main' ? ` (${e.threadId})` : ''}</span><span style={s.muted}>{e.model ?? ''}{e.finishReason ? ` · ${e.finishReason}` : ''}{usage}</span></summary>
          <pre style={s.pre}>{e.text || '(no text)'}</pre>
        </details>
      );
    }
    case 'tool':
      return (
        <details>
          <summary>
            <span style={s.chip}>tool: {e.name}</span>
            {e.server && <span style={s.badge}>MCP {e.server}</span>}
            {e.deferred && <span style={s.badge}>deferred</span>}
            {e.threadId !== 'main' && <span style={s.badge}>thread {e.threadId}</span>}
            {e.result === undefined && <span style={s.muted}> no result</span>}
          </summary>
          {e.args !== undefined && <pre style={s.pre}>args {json(e.args)}</pre>}
          {e.result !== undefined && <pre style={s.pre}>result {e.result}</pre>}
        </details>
      );
    case 'approval':
      return <div><span style={{ ...s.chip, background: statusColor[e.status] }}>approval: {e.name} · {e.status}</span>{e.reason && <span style={s.muted}> {e.reason}</span>}</div>;
    case 'thread':
      return (
        <div style={s.box}>
          <div>
            <span style={s.chip}>subagent: {e.title}</span>
            <span style={s.badge}>thread {e.threadId}</span>
            <span style={{ ...s.badge, color: statusColor[e.status] }}>{e.status}</span>
          </div>
          <div style={s.muted}>{[e.agent, e.model, e.parentThreadId ? `from ${e.parentThreadId}` : ''].filter(Boolean).join(' · ')}</div>
          {e.error && <div style={s.err}>{e.error}</div>}
        </div>
      );
    case 'turn-done':
      return <div style={e.error ? s.err : s.muted}>turn.done: {e.status}{e.reason ? ` (${e.reason})` : ''}{e.error ? ` - ${e.error}` : ''}</div>;
    case 'info':
      return <div style={s.muted}>{e.text}</div>;
  }
}

function Turn({ t, n }: { t: TurnView; n: number }) {
  const tok = t.totalTokens !== undefined ? ` · ${t.inputTokens ?? 0} in / ${t.outputTokens ?? 0} out (${t.totalTokens})` : '';
  return (
    <details open={n === 0 || t.status !== 'done'} style={s.box}>
      <summary>
        <span style={{ ...s.chip, background: statusColor[t.status] ?? undefined }}>turn {n + 1}: {t.status}</span>
        <span style={s.muted}>{when(t.createdAt)}{t.durationMs !== undefined ? ` · ${secs(t.durationMs)}` : ''}{tok}{t.costUsd ? ` · $${t.costUsd.toFixed(4)}` : ''}</span>
      </summary>
      {t.error && <div style={s.err}>{t.error}</div>}
      {t.entries.map((e, i) => <Entry key={i} e={e} />)}
    </details>
  );
}

function Session({ v }: { v: SessionView }) {
  return (
    <section style={{ ...s.box, gap: 6 }}>
      <div>
        <strong>{v.agent}</strong>
        {v.role === 'fallback' && <span style={{ ...s.badge, color: 'var(--vscode-editorWarning-foreground)' }}>fallback takeover</span>}
        {v.role === 'primary' && <span style={s.badge}>primary</span>}
        {v.sealed && <span style={s.badge}>sealed</span>}
      </div>
      <div style={s.muted}>session {v.id} · {v.model ?? 'model unknown'}{v.title ? ` · ${v.title}` : ''}</div>
      {v.turns.length === 0 && <div style={s.muted}>No turns.</div>}
      {v.turns.length > 1 && <details>
        <summary>Compare turns</summary>
        <table><thead><tr><th>Turn</th><th>Status</th><th>Duration</th><th>Tokens</th><th>Tool calls</th></tr></thead>
          <tbody>{v.turns.map((turn, i) => <tr key={turn.id}>
            <td>{i + 1}</td><td>{turn.status}</td><td>{secs(turn.durationMs) || '—'}</td>
            <td>{turn.totalTokens ?? '—'}</td><td>{turn.entries.filter(entry => entry.kind === 'tool').length}</td>
          </tr>)}</tbody></table>
      </details>}
      {v.turns.map((t, i) => <Turn key={t.id} t={t} n={i} />)}
    </section>
  );
}

export function SessionTab() {
  const [st, setSt] = useState(state);
  useEffect(() => {
    const l = () => setSt(state);
    listeners.add(l);
    post({ type: 'sessionLoad' });
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    if (!st.loaded || st.error || !st.sessions.some(session => !session.sealed &&
      session.turns.some(turn => !['done', 'cancelled', 'error', 'failed'].includes(turn.status)))) return;
    const timer = window.setTimeout(() => post({ type: 'sessionLoad', sessionIds: st.selected }), 3000);
    return () => window.clearTimeout(timer);
  }, [st]);
  const current = st.selected.length && st.recent.some((r) => r.id === st.selected[0]) ? st.selected[0] : '';
  return (
    <div style={s.root}>
      <div className="row">
        <select aria-label="Session" value={current} onChange={(e) => post(e.target.value ? { type: 'sessionLoad', sessionIds: [e.target.value] } : { type: 'sessionLoad' })} style={{ flex: 1, minWidth: 0 }}>
          <option value="">Current run</option>
          {st.recent.map((r) => (
            <option key={r.id} value={r.id}>{`${r.agent} · ${(r.title ?? r.id).slice(0, 40)} · ${when(r.createdAt)}${r.status ? ` · ${r.status}` : ''}`}</option>
          ))}
        </select>
        <button className="btn secondary" onClick={() => post(current ? { type: 'sessionLoad', sessionIds: [current] } : { type: 'sessionLoad' })}>Refresh</button>
      </div>
      {st.error && <div style={s.err} role="alert">Could not load sessions: {st.error}</div>}
      {st.loaded && !st.error && st.sessions.length === 0 && <div style={s.muted}>No session yet. Send a request in the Chat tab, or pick a recent session above.</div>}
      {!st.loaded && <div style={s.muted}>Loading...</div>}
      {st.sessions.map((v) => <Session key={v.id} v={v} />)}
    </div>
  );
}
