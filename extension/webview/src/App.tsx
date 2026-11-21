/**
 * App.tsx - webview shell (C1).
 *
 * Exports:
 *  - App (React component): tabs Chat / Session / Context / Changes / Settings (selected tab persisted with
 *    vscode.setState); run header with state pill, agent name and Stop button; banner from
 *    runState.banner; an agent input box that posts {type:'send'}; sends {type:'ready'} on mount.
 *    ChatTab / ContextTab / ChangesTab subscribe to the bridge themselves.
 *
 * Depends on: bridge.ts, ChatTab.tsx, ContextTab.tsx, ChangesTab.tsx. Depended on by: main.tsx.
 */
import { createElement, useEffect, useState } from 'react';
import { getState, post, setState, subscribe } from './bridge';
import type { RunStateMsg } from '../../src/types';
import { ChatTab } from './ChatTab';
import { SessionTab } from './SessionTab';
import { ContextTab } from './ContextTab';
import { ChangesTab } from './ChangesTab';
import { SettingsTab, Wizard } from './SetupView';
import type { SetupData } from './SetupView';
import type { ToWebview } from '../../src/types';

type Tab = 'chat' | 'session' | 'context' | 'changes' | 'settings';
const TABS: Array<[Tab, string]> = [['chat', 'Chat'], ['session', 'Session'], ['context', 'Context'], ['changes', 'Changes'], ['settings', 'Settings']];

export function App() {
  const [tab, setTab] = useState<Tab>(() => getState<{ tab?: Tab }>().tab ?? 'chat');
  const [run, setRun] = useState<RunStateMsg>({ state: 'idle' });
  const [text, setText] = useState('');
  const [setup, setSetup] = useState<SetupData>({ catalog: [], results: {} });
  const [skipped, setSkipped] = useState(() => getState<{ skipWizard?: boolean }>().skipWizard === true);

  useEffect(() => {
    const off = subscribe((m) => {
      if (m.type === 'runState') {
        const { type: _t, ...rest } = m;
        setRun(rest);
      } else {
        handleSetup(m);
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  const handleSetup = (m: ToWebview) => {
    if (m.type === 'setup') setSetup((d) => ({ ...d, status: m.status, catalog: m.catalog, settings: m.settings }));
    else if (m.type === 'setupResult') setSetup((d) => ({ ...d, results: { ...d.results, [m.op]: { ok: m.ok, message: m.message, steps: m.steps } } }));
    else if (m.type === 'showSetup') { skip(false); setWizardNeeded(true); }
  };
  const skip = (v: boolean) => {
    setSkipped(v);
    setState({ skipWizard: v });
  };
  const st = setup.status;
  const complete = !!st && st.trueforge === 'running' && st.models.length > 0 && !!st.primaryModel && st.connectorOk && st.agentsOk;
  // once the wizard has been needed it stays until the user finishes it (so the checklist/Done step is seen)
  const [wizardNeeded, setWizardNeeded] = useState(false);
  useEffect(() => { if (st && !complete) setWizardNeeded(true); }, [st, complete]);
  const showWizard = !!st && !skipped && (!complete || wizardNeeded);
  const choose = (t: Tab) => {
    setTab(t);
    setState({ tab: t });
  };
  const busy = run.state === 'streaming' || run.state === 'awaiting-review';
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    post({ type: 'send', text: t });
    setText('');
  };

  return (
    <div className="app">
      <header className="header">
        {createElement('contexo-glow', { 'aria-hidden': true })}
        <div className="identity"><strong>Contexo</strong><span className="pill" role="status">{run.state === 'awaiting-review' ? 'Awaiting review' : run.state}</span></div>
        <div className="header-actions">
          <button className="btn secondary" onClick={() => post({ type: 'reviewAction', action: 'workbench' })}>
            {run.state === 'awaiting-review' ? 'Review hunks' : 'Open workbench'}
          </button>
          {busy && <button className="btn" onClick={() => post({ type: 'stop' })}>Stop</button>}
        </div>
      </header>
      {setup.settings?.simulatedFailure && (
        <div role="alert" className="banner" style={{ fontWeight: 'bold' }}>
          Primary model is in simulated-failure mode. Restore it in Settings, Test resilience.
        </div>
      )}
      {run.state === 'failed' && run.banner && (
        <div
          role="alert"
          style={{
            padding: '8px',
            background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
            borderBottom: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
          }}
        >
          {run.banner}
        </div>
      )}
      {run.state !== 'failed' && run.banner && <div className="banner">{run.banner}</div>}
      {showWizard ? (
        <div className="content">
          <Wizard data={setup} onSkip={() => skip(true)} onDone={() => skip(true)} />
        </div>
      ) : (
      <>
      <nav className="tabs" aria-label="Assistant views">
        {TABS.map(([id, label]) => (
          <button key={id} aria-current={tab === id ? 'page' : undefined} className={`tab${tab === id ? ' active' : ''}`} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="content">
        {tab === 'chat' && <ChatTab onViewSession={() => choose('session')} />}
        {tab === 'session' && <SessionTab onViewContext={() => choose('context')} />}
        {tab === 'context' && <ContextTab />}
        {tab === 'changes' && <>
          <div className="review-tools" aria-label="Change review tools">
            {run.state === 'awaiting-review' && <button className="btn" onClick={() => post({type: 'reviewAction', action: 'check'})}>Test candidate</button>}
            <button className="btn secondary" onClick={() => post({type: 'reviewAction', action: 'restore'})}>Restore review</button>
            <button className="btn secondary" onClick={() => post({type: 'reviewAction', action: 'sync'})}>Fetch evidence</button>
          </div><ChangesTab /></>}
        {tab === 'settings' && <SettingsTab data={setup} />}
      </div>
      {tab !== 'settings' && tab !== 'session' && (
      <div className="composer">
        <textarea
          aria-label="Message the Contexo assistant"
          value={text}
          disabled={busy}
          placeholder={busy ? 'Run in progress...' : 'Ask the agent... (Enter to send, Shift+Enter for a new line)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
      )}
      </>
      )}
    </div>
  );
}
