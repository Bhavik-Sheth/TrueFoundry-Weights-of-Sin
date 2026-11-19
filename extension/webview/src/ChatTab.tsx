/**
 * ChatTab.tsx - Chat tab (C1).
 *
 * Exports:
 *  - ChatTab (React component): host-relayed renderer (the S0 spike decision is applied by whoever
 *    edits this file; this is the fallback renderer from the plan). Renders 'stream' and 'session'
 *    messages: merged model text, tool-call chips (with a "deferred" badge), approval chips, turn
 *    status, and an "Open in TrueForge" link. A send box posts { type: 'send' }.
 *  - State lives at module level (subscribed once) so history survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { UiStreamEvent } from '../../src/types';
import { post, subscribe } from './bridge';

type Item =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolCallId: string; name: string; deferred?: boolean; result?: string }
  | { kind: 'approval'; toolCallId: string; name: string; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'done'; status: string; error?: string }
  | { kind: 'info'; text: string };

interface ChatState { items: Item[]; session?: { sessionId: string; agent: string; url: string } }

let state: ChatState = { items: [] };
const listeners = new Set<() => void>();
function set(next: ChatState) { state = next; listeners.forEach((l) => l()); }

function applyEvents(items: Item[], events: UiStreamEvent[]): Item[] {
  const out = [...items];
  for (const e of events) {
    switch (e.kind) {
      case 'text-delta': {
        const last = out[out.length - 1];
        if (last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + e.text };
        else out.push({ kind: 'text', text: e.text });
        break;
      }
      case 'tool-call':
        out.push({ kind: 'tool', toolCallId: e.toolCallId, name: e.name, deferred: e.deferred });
        break;
      case 'tool-result': {
        const i = out.findIndex((x) => x.kind === 'tool' && x.toolCallId === e.toolCallId);
        if (i >= 0) out[i] = { ...(out[i] as Extract<Item, { kind: 'tool' }>), result: e.summary };
        break;
      }
      case 'approval': {
        const i = out.findIndex((x) => x.kind === 'approval' && x.toolCallId === e.toolCallId);
        const item: Item = { kind: 'approval', toolCallId: e.toolCallId, name: e.name, status: e.status, reason: e.reason };
        if (i >= 0) out[i] = item; else out.push(item);
        break;
      }
      case 'turn-done': out.push({ kind: 'done', status: e.status, error: e.error }); break;
      case 'info': out.push({ kind: 'info', text: e.text }); break;
    }
  }
  return out;
}

subscribe((m) => {
  if (m.type === 'stream') set({ ...state, items: applyEvents(state.items, m.events) });
  else if (m.type === 'session') set({ ...state, session: { sessionId: m.sessionId, agent: m.agent, url: m.url } });
});

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)' },
  text: { whiteSpace: 'pre-wrap', margin: 0 },
  chip: { display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', marginRight: 6 },
  badge: { padding: '0 6px', borderRadius: 8, fontSize: 10, border: '1px solid var(--vscode-focusBorder)', marginLeft: 6 },
  muted: { color: 'var(--vscode-descriptionForeground)', fontSize: 12 },
  link: { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer' },
  input: { flex: 1, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border, transparent)', padding: '4px 6px' },
  btn: { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 0, padding: '4px 10px', cursor: 'pointer' },
};

const approvalColor = { pending: 'var(--vscode-editorWarning-foreground)', allowed: 'var(--vscode-testing-iconPassed)', denied: 'var(--vscode-errorForeground)' };

export function ChatTab() {
  const [st, setSt] = useState(state);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const l = () => setSt(state);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    post({ type: 'send', text });
    setDraft('');
  };

  return (
    <div style={s.root}>
      {st.session && (
        <div style={s.muted}>
          Session {st.session.sessionId.slice(0, 8)} · {st.session.agent} ·{' '}
          <a style={s.link} href={st.session.url}>Open in TrueForge</a>
        </div>
      )}
      {st.items.length === 0 && <div style={s.muted}>No messages yet. Send a request below.</div>}
      {st.items.map((it, i) => {
        switch (it.kind) {
          case 'text': return <p key={i} style={s.text}>{it.text}</p>;
          case 'tool': return (
            <div key={i}>
              <span style={s.chip}>tool: {it.name}</span>
              {it.deferred && <span style={s.badge}>deferred</span>}
              {it.result && <span style={s.muted}> {it.result}</span>}
            </div>
          );
          case 'approval': return (
            <div key={i}>
              <span style={{ ...s.chip, background: approvalColor[it.status] }}>approval: {it.name} · {it.status}</span>
              {it.reason && <span style={s.muted}> {it.reason}</span>}
            </div>
          );
          case 'done': return <div key={i} style={it.error ? { color: 'var(--vscode-errorForeground)' } : s.muted}>Turn {it.status}{it.error ? `: ${it.error}` : ''}</div>;
          case 'info': return <div key={i} style={s.muted}>{it.text}</div>;
        }
      })}
      <div style={{ display: 'flex', gap: 6 }}>
        <input style={s.input} value={draft} placeholder="Message Contexo" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button style={s.btn} onClick={send}>Send</button>
      </div>
    </div>
  );
}
