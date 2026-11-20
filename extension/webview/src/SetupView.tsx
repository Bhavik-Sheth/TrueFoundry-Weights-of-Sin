/**
 * SetupView.tsx - onboarding wizard + Settings tab (host counterpart: src/shell/setupController.ts).
 *
 * Exports:
 *  - SetupData: { status, catalog, settings, results } state owned by App.
 *  - Wizard({ data, onSkip, onDone }): 5-step first-run flow (TrueForge, provider key, models, register, done).
 *  - SettingsTab({ data }): same controls always available + health rows + Test resilience + settings inputs + a small advanced TrueForge-UI link.
 *
 * Secrets: the API key lives only in a local useState for one submit; it is cleared right after posting.
 * Depends on: bridge.ts, src/types.ts. Depended on by: App.tsx.
 */
import { useState } from 'react';
import { inception } from '../../src/run/inception';
import { post } from './bridge';
import type { CatalogProviderView, SettingsView, SetupStatus, SetupStep } from '../../src/types';

export interface SetupData {
  status?: SetupStatus;
  catalog: CatalogProviderView[];
  settings?: SettingsView;
  results: Record<string, { ok: boolean; message: string; steps?: SetupStep[] }>;
}

const providerOf = (m: string) => m.split('/')[0];

function Result({ data, op }: { data: SetupData; op: string }) {
  const r = data.results[op];
  return (
    <div aria-live="polite" className="result">
      {r && (
        <div className={r.ok ? 'ok' : 'err'}>
          {r.message}
          {r.steps && (
            <ul className="checklist">
              {r.steps.map((s) => (
                <li key={s.label}>
                  <span aria-hidden="true">{s.ok ? '✔' : '✖'}</span> {s.label}
                  {s.detail ? ` - ${s.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function TrueForgeStep({ status }: { status: SetupStatus }) {
  const label = { running: 'Running', starting: 'Starting...', down: 'Not running', 'node-missing': 'Node.js 22.14+ required' }[status.trueforge];
  return (
    <section className="step">
      <h3>TrueForge</h3>
      <p>
        Status: <strong>{label}</strong>
      </p>
      {status.detail && status.trueforge !== 'running' && <p className={status.trueforge === 'node-missing' ? 'err' : ''}>{status.detail}</p>}
      {status.trueforge === 'node-missing' && (
        <p>Install Node.js 22.14 or newer from nodejs.org, then press Retry. (TrueForge runs on your machine via npx.)</p>
      )}
      <div className="row">
        <button className="btn" disabled={status.trueforge === 'starting'} onClick={() => post({ type: 'startTrueForge' })}>
          {status.trueforge === 'running' ? 'Re-check' : 'Start / Retry'}
        </button>
        {status.trueforge === 'running' && (
          <button className="btn secondary" onClick={() => post({ type: 'stopTrueForge' })}>
            Stop TrueForge
          </button>
        )}
      </div>
    </section>
  );
}

const OPENROUTER = 'openrouter';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Free OpenRouter chat models that list tool calling (checked 20 Nov 2026); editable before saving.
const OPENROUTER_DEFAULT_MODELS = 'google/gemma-4-31b-it:free, nvidia/nemotron-3-ultra-550b-a55b:free';

export function ProviderStep({ data }: { data: SetupData }) {
  const status = data.status!;
  const [type, setType] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelIds, setModelIds] = useState(OPENROUTER_DEFAULT_MODELS);
  const chosen = type || inception.name;
  // OpenRouter is not in TrueForge's catalog; it is OpenAI-compatible, so it is saved as a
  // TrueForge "custom" provider. TrueForge (not Contexo) calls this URL.
  const isInception = chosen === inception.name;
  const openRouter = chosen === OPENROUTER;
  const custom = !openRouter && (data.catalog.find((c) => c.type === chosen)?.custom ?? false);
  const ids = modelIds.split(',').map((s) => s.trim()).filter(Boolean);
  // A provider TrueForge already has keeps its stored key when the key field is left empty.
  const alreadySaved = status.providersConfigured.includes(openRouter ? OPENROUTER : custom ? name : chosen);
  const keyOk = !!key || alreadySaved;
  const canSave =
    status.trueforge === 'running' &&
    !!chosen &&
    (openRouter ? keyOk && ids.length > 0 : custom ? !!name && !!baseUrl && ids.length > 0 : keyOk);
  const save = () => {
    post({
      type: 'saveProvider',
      providerType: isInception || openRouter ? 'custom' : chosen,
      key,
      ...(isInception
        ? { name: inception.name, baseUrl: inception.baseUrl, modelIds: [inception.model] }
        : openRouter
        ? { name: 'openrouter', baseUrl: OPENROUTER_BASE_URL, modelIds: ids }
        : custom
          ? { name, baseUrl, modelIds: ids }
          : {}),
    });
    setKey(''); // clear immediately: the key is never kept in the UI
  };
  return (
    <section className="step">
      <h3>Add a model provider</h3>
      <p>Your key is sent once to your local TrueForge, which stores it. Contexo never keeps it.</p>
      <label htmlFor="prov-type">Provider</label>
      <select id="prov-type" value={chosen} onChange={(e) => setType(e.target.value)}>
        <option value={inception.name}>Inception · Mercury 3</option>
        {data.catalog.filter(c => c.type !== inception.name).map((c) => (
          <option key={c.type} value={c.type}>
            {c.type}
          </option>
        ))}
        <option value={OPENROUTER}>openrouter</option>
      </select>
      {isInception && <p>Mercury 3 · {inception.baseUrl}</p>}
      {openRouter && (
        <>
          <label htmlFor="prov-or-models">OpenRouter model ids (comma separated)</label>
          <input
            id="prov-or-models"
            placeholder="e.g. anthropic/claude-sonnet-4.5, openai/gpt-4o"
            value={modelIds}
            onChange={(e) => setModelIds(e.target.value)}
          />
          <p>Use the ids from openrouter.ai/models. Saved in TrueForge as a custom OpenAI-compatible provider.</p>
        </>
      )}
      {custom && (
        <>
          <label htmlFor="prov-name">Name</label>
          <input id="prov-name" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="prov-url">Base URL (OpenAI-compatible)</label>
          <input id="prov-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <label htmlFor="prov-models">Model ids (comma separated)</label>
          <input id="prov-models" value={modelIds} onChange={(e) => setModelIds(e.target.value)} />
        </>
      )}
      <label htmlFor="prov-key">
        API key{alreadySaved ? ' (saved in TrueForge; leave empty to keep it, or paste a new one)' : custom ? ' (optional)' : ''}
      </label>
      <input id="prov-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
      <div className="row">
        <button className="btn" disabled={!canSave} onClick={save}>
          Save to TrueForge
        </button>
      </div>
      <Result data={data} op="saveProvider" />
      <p>
        Configured providers: {status.providersConfigured.length ? status.providersConfigured.join(', ') : <em>none yet</em>}
      </p>
    </section>
  );
}

export function ModelStep({ data }: { data: SetupData }) {
  const status = data.status!;
  const [primary, setPrimary] = useState(status.primaryModel ?? '');
  const [fallback, setFallback] = useState(status.fallbackModel ?? '');
  const sameProvider = !!primary && !!fallback && providerOf(primary) === providerOf(fallback);
  const opts = (
    <>
      <option value="">(choose)</option>
      {status.models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </>
  );
  return (
    <section className="step">
      <h3>Choose models</h3>
      {status.models.length === 0 ? (
        <p>No models yet. Add a provider above; its models appear here.</p>
      ) : (
        <>
          <label htmlFor="m-primary">Primary model</label>
          <select id="m-primary" value={primary} onChange={(e) => setPrimary(e.target.value)}>
            {opts}
          </select>
          <label htmlFor="m-fallback">Fallback model</label>
          <select id="m-fallback" value={fallback} onChange={(e) => setFallback(e.target.value)}>
            {opts}
          </select>
          <p>
            Pick chat models that support <strong>tool calling</strong>: Contexo's agent reads and edits code through tools.
            Image, audio and embedding models will fail. On OpenRouter, filter models by "Tools".
          </p>
          {primary && primary === (fallback || primary) ? (
            <p className="warn">Primary and fallback are the same model, so the fallback cannot help if that model fails. Pick a different fallback.</p>
          ) : (
            sameProvider && <p className="warn">Both models use the same provider, so a provider outage would take both down.</p>
          )}
          <div className="row">
            <button className="btn" disabled={!primary} onClick={() => post({ type: 'setModels', primary, fallback: fallback || primary })}>
              Save models
            </button>
          </div>
          <Result data={data} op="setModels" />
        </>
      )}
    </section>
  );
}

export function RegisterStep({ data }: { data: SetupData }) {
  const status = data.status!;
  return (
    <section className="step">
      <h3>Register Contexo in TrueForge</h3>
      <p>Creates the editor-tools connector and the contexo / contexo-fallback agents (safe to repeat).</p>
      <div className="row">
        <button className="btn" disabled={status.trueforge !== 'running' || !status.primaryModel} onClick={() => post({ type: 'register' })}>
          Register
        </button>
      </div>
      <Result data={data} op="register" />
    </section>
  );
}

const flag = (ok: boolean) => (ok ? '✔ OK' : '✖ Not ready');

export function Wizard({ data, onSkip, onDone }: { data: SetupData; onSkip: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const status = data.status;
  if (!status) return <p>Checking setup...</p>;
  const complete = status.trueforge === 'running' && status.models.length > 0 && !!status.primaryModel && status.connectorOk && status.agentsOk;
  const steps = ['TrueForge', 'Provider', 'Models', 'Register', 'Done'];
  return (
    <div className="wizard">
      <h2>Set up Contexo</h2>
      <ol className="stepper" aria-label="Setup steps">
        {steps.map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? 'cur' : ''}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      {step === 1 && <TrueForgeStep status={status} />}
      {step === 2 && <ProviderStep data={data} />}
      {step === 3 && <ModelStep data={data} />}
      {step === 4 && <RegisterStep data={data} />}
      {step === 5 && (
        <section className="step">
          <h3>{complete ? 'All set' : 'Almost there'}</h3>
          <p>{complete ? 'Contexo is ready. Select code and press Ctrl+K E, or ask the agent in the Chat tab.' : 'Some steps are still incomplete; go back and finish them.'}</p>
          <div className="row">
            <button className="btn" disabled={!complete} onClick={onDone}>
              Open Contexo
            </button>
          </div>
        </section>
      )}
      <div className="row nav">
        <button className="btn secondary" disabled={step === 1} onClick={() => setStep(step - 1)}>
          Back
        </button>
        <button className="btn" disabled={step === 5} onClick={() => setStep(step + 1)}>
          Next
        </button>
        <span className="spacer" />
        <button className="btn secondary" onClick={onSkip}>
          Skip to tabs
        </button>
      </div>
    </div>
  );
}

export function SettingsTab({ data }: { data: SetupData }) {
  const status = data.status;
  const s = data.settings;
  const [allow, setAllow] = useState<string | undefined>();
  if (!status || !s) return <p>Loading...</p>;
  const num = (key: 'excerptBudget' | 'firstEventTimeoutMs', label: string) => (
    <>
      <label htmlFor={`s-${key}`}>{label}</label>
      <input
        id={`s-${key}`}
        type="number"
        min={1}
        defaultValue={s[key]}
        key={`${key}-${s[key]}`}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (v > 0 && v !== s[key]) post({ type: 'updateSetting', key, value: v });
        }}
      />
    </>
  );
  const check = (key: 'autoStartTrueForge' | 'devMode', label: string) => (
    <label className="check">
      <input type="checkbox" checked={s[key]} onChange={(e) => post({ type: 'updateSetting', key, value: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div className="settings">
      <section className="step">
        <h3>Health</h3>
        <table className="health">
          <tbody>
            <tr><th scope="row">TrueForge</th><td>{status.trueforge === 'running' ? '✔ Running' : `✖ ${status.trueforge}`}</td></tr>
            <tr><th scope="row">MCP server</th><td>{flag(status.mcpOk)}</td></tr>
            <tr><th scope="row">Connector</th><td>{flag(status.connectorOk)}</td></tr>
            <tr><th scope="row">Agents</th><td>{flag(status.agentsOk)}</td></tr>
            <tr><th scope="row">Index</th><td>{status.indexReady ? '✔ Ready' : 'Indexing...'}</td></tr>
          </tbody>
        </table>
        <div className="row">
          <button className="btn secondary" onClick={() => post({ type: 'setupRefresh' })}>Check health</button>
        </div>
      </section>
      <TrueForgeStep status={status} />
      {status.trueforge === 'running' && (
        <>
          <ProviderStep data={data} />
          <ModelStep data={data} />
          <RegisterStep data={data} />
        </>
      )}
      <section className="step">
        <h3>Test resilience</h3>
        <p>
          Simulates the primary model failing: the contexo agent is re-registered on a deliberately unreachable model
          (a custom provider named contexo-broken). Run a task and the fallback agent takes over; if both models fail you get a clear error.
        </p>
        {s.simulatedFailure ? (
          <p className="warn">Primary model is in simulated-failure mode.</p>
        ) : (
          <p>Primary model is normal.</p>
        )}
        <div className="row">
          <button className="btn" disabled={status.trueforge !== 'running' || s.simulatedFailure} onClick={() => post({ type: 'simulateFailure', on: true })}>
            Simulate primary model failure
          </button>
          <button className="btn secondary" disabled={status.trueforge !== 'running' || !s.simulatedFailure} onClick={() => post({ type: 'simulateFailure', on: false })}>
            Restore primary model
          </button>
        </div>
        <Result data={data} op="simulateFailure" />
      </section>
      <section className="step">
        <h3>Settings</h3>
        <p>First-event timeout applies after a window reload.</p>
        {num('excerptBudget', 'Excerpt budget (tokens)')}
        {num('firstEventTimeoutMs', 'First event timeout (ms)')}
        <label htmlFor="s-allow">Command allowlist (comma separated)</label>
        <input
          id="s-allow"
          value={allow ?? s.commandAllowlist.join(', ')}
          onChange={(e) => setAllow(e.target.value)}
          onBlur={() => {
            if (allow !== undefined) post({ type: 'updateSetting', key: 'commandAllowlist', value: allow.split(',').map((x) => x.trim()).filter(Boolean) });
            setAllow(undefined);
          }}
        />
        {check('autoStartTrueForge', 'Start TrueForge automatically')}
        {check('devMode', 'Dev mode (show dev commands)')}
        <Result data={data} op="updateSetting" />
      </section>
      <p className="muted">
        <a href="#" onClick={(e) => { e.preventDefault(); post({ type: 'openTrueForge' }); }}>Advanced: open TrueForge web UI</a> (never required).
      </p>
    </div>
  );
}
