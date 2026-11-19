/**
 * App.tsx - webview shell (C1).
 *
 * Exports:
 *  - App (React component): tabs Chat / Context / Changes (selected tab persisted with
 *    vscode.setState); run header with state pill, agent name and Stop button; banner from
 *    runState.banner; an agent input box that posts {type:'send'}; sends {type:'ready'} on mount.
 *    ChatTab / ContextTab / ChangesTab subscribe to the bridge themselves.
 *
 * Depends on: bridge.ts, ChatTab.tsx, ContextTab.tsx, ChangesTab.tsx. Depended on by: main.tsx.
 */
import { useEffect, useState } from 'react';
import { getState, post, setState, subscribe } from './bridge';
import type { RunStateMsg } from '../../src/types';
import { ChatTab } from './ChatTab';
import { ContextTab } from './ContextTab';
import { ChangesTab } from './ChangesTab';

type Tab = 'chat' | 'context' | 'changes';
const TABS: Array<[Tab, string]> = [['chat', 'Chat'], ['context', 'Context'], ['changes', 'Changes']];

export function App() {
  const [tab, setTab] = useState<Tab>(() => getState<{ tab?: Tab }>().tab ?? 'chat');
  const [run, setRun] = useState<RunStateMsg>({ state: 'idle' });
  const [text, setText] = useState('');

  useEffect(() => {
    const off = subscribe((m) => {
      if (m.type === 'runState') {
        const { type: _t, ...rest } = m;
        setRun(rest);
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  const choose = (t: Tab) => {
    setTab(t);
    setState({ tab: t });
  };
  const busy = run.state === 'streaming' || run.state === 'awaiting-review';
  const send = () => {
    const t = text.trim();
    if (!t) return;
    post({ type: 'send', text: t });
    setText('');
  };

  return (
    <div className="app">
      <div className="header">
        <span className="pill">{run.state}</span>
        {run.agent && <span>{run.agent}</span>}
        <span className="spacer" />
        <button className="btn" disabled={!busy} onClick={() => post({ type: 'stop' })}>
          Stop
        </button>
      </div>
      {run.banner && <div className="banner">{run.banner}</div>}
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="content">
        {tab === 'chat' && <ChatTab />}
        {tab === 'context' && <ContextTab />}
        {tab === 'changes' && <ChangesTab />}
      </div>
      <div className="composer">
        <textarea
          value={text}
          placeholder="Ask the agent..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
