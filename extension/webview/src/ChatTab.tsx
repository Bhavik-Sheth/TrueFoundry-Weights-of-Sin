/**
 * ChatTab.tsx - Chat tab (C1).
 *
 * Exports:
 *  - ChatTab (React component): host-relayed renderer (the S0 spike chose this over TrueForgeUI).
 *    Renders 'stream' and 'session' messages: model text merged per thread (preformatted wrapped
 *    Markdown), tool-call chips (name, collapsible args JSON, result summary, "deferred"
 *    badge), approval chips with status, a turn status line, and a "View session" link (opens the Session tab).
 *    Auto-scrolls to the bottom unless the user scrolled up. A new 'session' clears the history.
 *    The send box lives in App.tsx.
 *  - State lives at module level (subscribed once) so history survives tab switches.
 *
 * Depends on: bridge.ts, ../../src/types. Depended on by: App.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import type { UiStreamEvent } from '../../src/types';
import { post, subscribe } from './bridge';
import { MessageBody } from './MessageBody';

type Item =
  | { kind: 'text'; text: string; threadId?: string }
  | { kind: 'tool'; toolCallId: string; name: string; args?: unknown; deferred?: boolean; result?: string }
  | { kind: 'approval'; toolCallId: string; name: string; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'done'; status: string; error?: string }
  | { kind: 'info'; text: string }
  | { kind: 'action'; action: 'regenerate'; path: string; label: string };

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
      case 'action': out.push({ kind: 'action', action: e.action, path: e.path, label: e.label }); break;
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

export function ChatTab({ onViewSession, streaming }: { onViewSession?: () => void; streaming?: boolean }) {
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
    <section className="chat-feed" aria-label="Conversation">
      {st.session && <div className="chat-session">
        <span>{st.session.agent}</span>
        <button className="inline-action" type="button" onClick={onViewSession}>Session activity</button>
      </div>}
      {st.items.length === 0 && <p className="muted">Ask about your workspace or describe a change to review.</p>}
      {st.items.map((it, i) => {
        switch (it.kind) {
          case 'text': return <MessageBody key={i} text={it.text} />;
          case 'tool': return <details className="activity-entry" key={it.toolCallId}>
            <summary className="activity-heading">
              <span className="activity-name">{it.name}</span>
              <span className="activity-meta">{it.result !== undefined ? 'Result' : 'Running'}{it.deferred && ' · on demand'}</span>
            </summary>
            {it.args !== undefined && <div className="activity-detail"><span>Input</span><pre>{argsJson(it.args)}</pre></div>}
            {it.result !== undefined && <div className="activity-detail"><span>Result</span><pre>{it.result}</pre></div>}
          </details>;
          case 'approval': return <div className="activity-notice" key={i}>
            <span className="activity-name">{it.name}</span>
            <span className={it.status === 'denied' ? 'err' : it.status === 'allowed' ? 'ok' : 'warn'}>
              {it.status === 'pending' ? 'Approval requested' : it.status}
            </span>
            {it.reason && <span className="muted">{it.reason}</span>}
          </div>;
          case 'done': return it.error
            ? <p key={i} className="err" role="alert">{it.error}</p>
            : <p key={i} className="muted">Turn {it.status}</p>;
          case 'info': return <p key={i} className="muted">{it.text}</p>;
          case 'action': return <button key={i} className="inline-action" type="button" disabled={streaming}
            onClick={() => post({ type: 'regenerate', path: it.path })}>{it.label}</button>;
        }
      })}
      <div ref={endRef} />
    </section>
  );
}
