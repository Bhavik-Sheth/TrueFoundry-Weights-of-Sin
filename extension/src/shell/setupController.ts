/**
 * shell/setupController.ts - host side of the onboarding wizard / Settings tab.
 *
 * Exports: class SetupController
 *  - init(): auto-starts TrueForge (if configured), refreshes status, silently re-ensures the connector when setup is complete.
 *  - handle(msg): processes the setup-related ToHost messages (see types.ts), posts 'setup' / 'setupResult'.
 *  - onReady(): re-posts status (and a pending 'showSetup') when the webview mounts.
 *  - dispose(): stops the TrueForge child ONLY if this extension started it.
 *
 * Secrets: provider keys arrive in a message, go straight to TrueForge's API and are dropped. They are never logged,
 * stored in settings/SecretStorage, or put in result messages. Models and primary/fallback names live in settings.
 * Depends on: vscode, config, log, run/*, shell/setup, types, trueforge/instructions.md (bundled as text).
 */
import * as vscode from 'vscode';
import instructions from '../../trueforge/instructions.md';
import { getConfig } from '../config';
import { log } from '../log';
import type { CatalogProviderView, SettingKey, SettingsView, SetupStatus, SetupStep, ToHost, ToWebview } from '../types';
import { createAdmin } from '../run/trueforgeAdmin';
import type { ProviderList, TrueForgeAdmin } from '../run/trueforgeAdmin';
import { ensureTrueForge, isLocalUrl, portOf, stopTrueForgeOnPort } from '../run/trueforgeProcess';
import type { TfProcHandle, TfProcState } from '../run/trueforgeProcess';
import { computeSetupStatus, isSetupComplete } from './setup';
import { createFailureSim, expectedPrimaryModel } from '../run/failureMode';
import type { FailureSim } from '../run/failureMode';
import { BROKEN_PROVIDER } from '../run/manifests';

export interface SetupDeps {
  post: (m: ToWebview) => void;
  token: string;
  mcpPort: number;
  index: { ready: Promise<void>; symbols(): unknown[] };
  /** Persistent "simulated primary failure" flag (extension globalState). */
  failureStore: { get(): boolean; set(v: boolean): void | PromiseLike<void> };
}

const SETTING_KEYS: Record<SettingKey, 'number' | 'boolean' | 'array'> = {
  excerptBudget: 'number',
  firstEventTimeoutMs: 'number',
  commandAllowlist: 'array',
  autoStartTrueForge: 'boolean',
  devMode: 'boolean',
};

export class SetupController {
  private admin: TrueForgeAdmin;
  private sim: FailureSim;
  private proc?: TfProcHandle;
  private state: TfProcState = 'down';
  private detail?: string;
  private starting?: Promise<void>;
  private indexReady = false;
  private pendingShow = false;
  private catalog: CatalogProviderView[] = [];
  private lastProviders: ProviderList = { catalog: [], configured: [] };

  constructor(private readonly deps: SetupDeps) {
    this.admin = this.makeAdmin();
    this.sim = this.makeSim();
    void deps.index.ready.then(() => { this.indexReady = true; void this.refresh(); });
  }

  private makeAdmin(): TrueForgeAdmin {
    return createAdmin(getConfig().trueforgeUrl, { log });
  }

  private makeSim(): FailureSim {
    return createFailureSim({
      admin: { ensureBrokenProvider: () => this.admin.ensureBrokenProvider(), deleteBrokenProvider: () => this.admin.deleteBrokenProvider(), ensureAgent: (k, m, i) => this.admin.ensureAgent(k, m, i) },
      store: this.deps.failureStore,
      primaryModel: () => getConfig().primaryModel,
      instructions,
    });
  }

  /** Auto-start + status; when setup is already complete, silently refresh the connector (token/port may differ). */
  async init(): Promise<void> {
    await this.start(getConfig().autoStartTrueForge);
    const status = await this.refresh();
    if (isSetupComplete(status)) {
      try { await this.admin.ensureConnector(this.deps.mcpPort, this.deps.token); await this.refresh(); }
      catch (e) { log('setup: silent connector refresh failed', String(e)); }
    }
  }

  private start(autoStart: boolean): Promise<void> {
    this.starting ??= (async () => {
      try {
        this.admin = this.makeAdmin();
        const h = await ensureTrueForge({
          url: getConfig().trueforgeUrl,
          autoStart,
          ping: () => this.admin.health(),
          log,
          onState: (s, d) => { this.state = s; this.detail = d; void this.refresh(true); },
        });
        if (h.startedByUs) this.proc = h;
        this.state = h.state;
        this.detail = h.detail;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  onReady(): void {
    void this.refresh();
    if (this.pendingShow) { this.pendingShow = false; this.deps.post({ type: 'showSetup' }); }
  }

  showSetup(): void {
    this.pendingShow = true;
    this.deps.post({ type: 'showSetup' });
  }

  settingsView(): SettingsView {
    const c = getConfig();
    return {
      excerptBudget: c.excerptBudget,
      firstEventTimeoutMs: c.firstEventTimeoutMs,
      commandAllowlist: c.commandAllowlist,
      autoStartTrueForge: c.autoStartTrueForge,
      devMode: c.devMode,
      trueforgeUrl: c.trueforgeUrl,
      simulatedFailure: this.sim.active,
    };
  }

  /** Builds and posts the status. `light` skips network calls (progress ticks while starting). */
  async refresh(light = false): Promise<SetupStatus> {
    const cfg = getConfig();
    let state = this.state;
    let providers = this.lastProviders;
    let models: string[] = [];
    let connectorOk = false;
    let agentsOk = false;
    if (!light && state !== 'starting') {
      if (await this.admin.health()) {
        state = 'running';
        const [p, m, i] = await Promise.all([
          this.admin.listProviders().catch(() => this.lastProviders),
          this.admin.listModels().catch(() => [] as string[]),
          this.admin.inspect(),
        ]);
        providers = { ...p, configured: p.configured.filter((n) => n !== BROKEN_PROVIDER) };
        models = m.filter((x) => !x.startsWith(`${BROKEN_PROVIDER}/`));
        connectorOk = i.connectorOk;
        agentsOk = i.agentsOk && (!cfg.primaryModel || i.agentModels.primary === expectedPrimaryModel(this.sim.active, cfg.primaryModel));
      } else if (state === 'running') {
        state = 'down';
      }
      this.state = state;
    } else if (light) {
      state = this.state;
    }
    this.lastProviders = providers;
    this.catalog = providers.catalog.map((c) => ({ type: c.type, custom: c.custom }));
    const status = computeSetupStatus({
      trueforge: state, detail: this.detail,
      providersConfigured: providers.configured, models,
      primaryModel: cfg.primaryModel, fallbackModel: cfg.fallbackModel,
      connectorOk, agentsOk, mcpOk: true, indexReady: this.indexReady || this.deps.index.symbols().length > 0,
    });
    this.deps.post({ type: 'setup', status, catalog: this.catalog, settings: this.settingsView() });
    return status;
  }

  private result(op: string, ok: boolean, message: string, steps?: SetupStep[]): void {
    this.deps.post({ type: 'setupResult', op, ok, message, steps });
  }

  async handle(m: ToHost): Promise<void> {
    switch (m.type) {
      case 'setupRefresh':
        await this.refresh();
        break;
      case 'startTrueForge':
        await this.start(true);
        await this.refresh();
        break;
      case 'stopTrueForge': {
        const message = await this.stopTrueForge();
        this.deps.post({ type: 'setupResult', op: 'stopTrueForge', ok: true, message });
        break;
      }
      case 'openTrueForge':
        void vscode.env.openExternal(vscode.Uri.parse(getConfig().trueforgeUrl));
        break;
      case 'saveProvider': {
        let key = m.key; // forwarded once; never logged or stored
        try {
          await this.admin.configureProvider(m.providerType, key, { name: m.name, baseUrl: m.baseUrl, modelIds: m.modelIds });
          this.result('saveProvider', true, `Saved ${m.providerType} to TrueForge.`);
        } catch (e) {
          this.result('saveProvider', false, e instanceof Error ? e.message : 'Could not save the provider.');
        } finally {
          key = '';
        }
        await this.refresh();
        break;
      }
      case 'setModels': {
        const cfgW = vscode.workspace.getConfiguration('contexo');
        await cfgW.update('primaryModel', m.primary, vscode.ConfigurationTarget.Global);
        await cfgW.update('fallbackModel', m.fallback, vscode.ConfigurationTarget.Global);
        const status = await this.refresh();
        // On a model change, re-ensure agents when the connector is already registered.
        if (status.trueforge === 'running' && m.primary && status.connectorOk) await this.register(true);
        else this.result('setModels', true, 'Models saved.');
        break;
      }
      case 'register':
        await this.register(false);
        break;
      case 'simulateFailure':
        await this.simulateFailure(m.on);
        break;
      case 'updateSetting':
        await this.updateSetting(m.key, m.value);
        break;
      default:
        break;
    }
  }

  private async register(quiet: boolean): Promise<void> {
    const cfg = getConfig();
    const steps: SetupStep[] = [];
    if (!cfg.primaryModel) {
      this.result('register', false, 'Choose a primary model first.', steps);
      return;
    }
    try {
      await this.admin.ensureConnector(this.deps.mcpPort, this.deps.token);
      steps.push({ label: 'MCP connector contexo-editor', ok: true });
    } catch (e) {
      steps.push({ label: 'MCP connector contexo-editor', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    try {
      const done = await this.admin.ensureAgents(expectedPrimaryModel(this.sim.active, cfg.primaryModel), cfg.fallbackModel || undefined, instructions);
      for (const d of done) steps.push({ label: `Agent ${d.name}`, ok: true, detail: d.action });
    } catch (e) {
      steps.push({ label: 'Agents contexo / contexo-fallback', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    const ok = steps.every((s) => s.ok);
    this.result('register', ok, ok ? (quiet ? 'Models updated.' : 'Registered in TrueForge.') : 'Registration failed.', steps);
    await this.refresh();
  }

  private async simulateFailure(on: boolean): Promise<void> {
    try {
      if (on) await this.sim.simulate(); else await this.sim.restore();
      this.result('simulateFailure', true, on ? 'Primary model is now broken on purpose. Run a task to see the fallback take over.' : 'Primary model restored.');
    } catch (e) {
      this.result('simulateFailure', false, e instanceof Error ? e.message : 'Could not change the failure mode.');
    }
    await this.refresh();
  }

  private async updateSetting(key: SettingKey, value: unknown): Promise<void> {
    const kind = SETTING_KEYS[key];
    if (!kind) return;
    let v: unknown;
    if (kind === 'number') v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
    else if (kind === 'boolean') v = typeof value === 'boolean' ? value : undefined;
    else v = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : undefined;
    if (v === undefined) {
      this.result('updateSetting', false, `Invalid value for ${key}.`);
    } else {
      await vscode.workspace.getConfiguration('contexo').update(key, v, vscode.ConfigurationTarget.Global);
      this.result('updateSetting', true, `Saved ${key}.`);
    }
    await this.refresh(true);
  }

  /** Stops TrueForge: our own child if we started it, otherwise whatever listens on the local TrueForge port. */
  async stopTrueForge(): Promise<string> {
    const url = getConfig().trueforgeUrl;
    if (this.proc) {
      const p = this.proc;
      this.proc = undefined;
      await p.stop();
    } else if (isLocalUrl(url)) {
      const pids = await stopTrueForgeOnPort(portOf(url), log);
      if (!pids.length) return 'No local TrueForge process was found.';
    } else {
      return 'TrueForge is not local; Contexo can only stop a local TrueForge.';
    }
    this.state = 'down';
    this.detail = 'TrueForge was stopped from Contexo. Press Start to run it again.';
    await this.refresh();
    return 'TrueForge stopped.';
  }

  /** On VS Code exit: contexo.stopTrueForgeOnExit = 'startedByContexo' (default) | 'always' | 'never'. */
  async dispose(): Promise<void> {
    const mode = getConfig().stopTrueForgeOnExit;
    if (mode === 'never') { this.proc = undefined; return; }
    if (mode === 'always') { await this.stopTrueForge().catch(() => undefined); return; }
    const p = this.proc;
    this.proc = undefined;
    await p?.stop();
  }
}
