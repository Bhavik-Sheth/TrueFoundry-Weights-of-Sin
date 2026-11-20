/**
 * ChatTab.tsx - Chat tab (C1).
 *
 * Exports:
 *  - ChatTab (React component): host-relayed renderer (the S0 spike chose this over TrueForgeUI).
 *    Renders 'stream' and 'session' messages: model text merged per thread (preformatted wrapped
 *    text, never HTML), tool-call chips (name, collapsible args JSON, result summary, "deferred"
 *    badge), approval chips with status, a turn status line, and a "View session" link (opens the Session tab).
 *    Auto-scrolls to the bottom unless the user scrolled up. A new 'session' clears the history.
 *    The send box lives in App.tsx.
 *  - State lives at module level (subscribed once) so history survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { UiStreamEvent } from '../../src/types';
import { subscribe } from './bridge';

type Item =
  | { kind: 'text'; text: string; threadId?: string }
  | { kind: 'tool'; toolCallId: string; name: string; args?: unknown; deferred?: boolean; result?: string }
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
        if (last && last.kind === 'text' && last.threadId === e.threadId) out[out.length - 1] = { ...last, text: last.text + e.text };
        else out.push({ kind: 'text', text: e.text, threadId: e.threadId });
        break;
      }
      case 'tool-call':
        out.push({ kind: 'tool', toolCallId: e.toolCallId, name: e.name, args: e.args, deferred: e.deferred });
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
  else if (m.type === 'session') set({ items: [], session: { sessionId: m.sessionId, agent: m.agent, url: m.url } });
});

function argsJson(args: unknown): string {
  try { return JSON.stringify(args, null, 2) ?? ''; } catch { return String(args); }
}

const s: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)' },
  text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, fontFamily: 'inherit' },
  chip: { display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 11, background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', marginRight: 6 },
  badge: { padding: '0 6px', borderRadius: 8, fontSize: 10, border: '1px solid var(--vscode-focusBorder)', marginLeft: 6 },
  muted: { color: 'var(--vscode-descriptionForeground)', fontSize: 12 },
  link: { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer' },
  args: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0 0', fontSize: 11, background: 'var(--vscode-textCodeBlock-background)', padding: 6 },
};

const approvalColor = { pending: 'var(--vscode-editorWarning-foreground)', allowed: 'var(--vscode-testing-iconPassed)', denied: 'var(--vscode-errorForeground)' };

export function ChatTab({ onViewSession }: { onViewSession?: () => void }) {
  const [st, setSt] = useState(state);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const l = () => setSt(state);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);

  // The scroll container is the nearest scrollable ancestor (App's .content).
  useEffect(() => {
    const parent = endRef.current?.closest('.content') ?? endRef.current?.parentElement;
    if (!parent) return;
    const onScroll = () => { stick.current = parent.scrollHeight - parent.scrollTop - parent.clientHeight < 40; };
    parent.addEventListener('scroll', onScroll);
    return () => parent.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [st]);

  return (
    <div style={s.root}>
      {st.session && (
        <div style={s.muted}>
          Session {st.session.sessionId.slice(0, 8)} · {st.session.agent} ·{' '}
          <a style={s.link} role="button" tabIndex={0} onClick={onViewSession} onKeyDown={(e) => { if (e.key === 'Enter') onViewSession?.(); }}>View session</a>
        </div>
      )}
      {st.items.length === 0 && <div style={s.muted}>No messages yet. Send a request below.</div>}
      {st.items.map((it, i) => {
        switch (it.kind) {
          case 'text': return <pre key={i} style={s.text}>{it.text}</pre>;
          case 'tool': {
            const json = it.args === undefined ? '' : argsJson(it.args);
            return (
              <div key={i}>
                <span style={s.chip}>tool: {it.name}</span>
                {it.deferred && <span style={s.badge}>deferred</span>}
                {it.result !== undefined && <span style={s.muted}> {it.result.length > 80 ? `${it.result.slice(0, 80)}… (${it.result.length} chars)` : it.result}</span>}
                {json && (
                  <details>
                    <summary style={s.muted}>args</summary>
                    <pre style={s.args}>{json}</pre>
                  </details>
                )}
              </div>
            );
          }
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
      <div ref={endRef} />
    </div>
  );
}
