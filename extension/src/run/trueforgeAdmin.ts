/**
 * run/trueforgeAdmin.ts - onboarding/admin calls against TrueForge's own API (SDK v0.185.0).
 * Only this file and tfClient.ts import the SDK.
 *
 * The extension NEVER talks to a model provider: provider keys are forwarded once to TrueForge
 * (settings.modelProviders.createOrUpdate), never stored, never logged; every error message is scrubbed of the key.
 *
 * Exports: createAdmin(baseUrl, deps?): TrueForgeAdmin with health, listProviders, configureProvider, listModels,
 *          ensureConnector, ensureAgents, inspect; friendlyError.
 * Depends on: SDK, run/manifests. Depended on by: shell/setupController, tests, live-check script.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { AGENT_NAMES, BROKEN_PROVIDER, CONNECTOR_NAME, buildAgentRequest, buildBrokenProviderManifest, buildConnectorManifest, modelFqn } from './manifests';

export interface CatalogProviderInfo {
  type: string;
  models: Array<{ modelId: string; name: string }>;
  custom: boolean;
}
export interface ProviderList { catalog: CatalogProviderInfo[]; configured: string[] }
export interface ExtraProviderFields { name?: string; baseUrl?: string; modelIds?: string[] }

/** Structural view of the SDK client (lets tests inject a fake). */
export type AdminClient = Pick<TrueForge, 'server' | 'models' | 'settings' | 'catalogs' | 'agents'> & Partial<Pick<TrueForge, 'sandboxEnvironments'>>;

export interface AdminDeps { agentNames?: Record<'primary' | 'fallback', string>; client?: AdminClient; log?: (...a: unknown[]) => void }

function bodyMessage(e: unknown): string {
  const body = (e as { body?: { error?: { message?: unknown } } })?.body;
  const m = body?.error?.message;
  return typeof m === 'string' ? m : '';
}

export function friendlyError(e: unknown, secrets: string[] = []): Error {
  const err = e as { statusCode?: number; message?: string; cause?: { code?: string }; name?: string };
  let msg: string;
  if (err?.statusCode === 401 || err?.statusCode === 403) msg = 'TrueForge rejected the request (unauthorized).';
  else if (err?.statusCode === 409) msg = 'TrueForge reports a conflict (the resource already exists).';
  else if (err?.statusCode === 400 && /Outbound URL blocked/.test(bodyMessage(e))) {
    msg = 'TrueForge blocks connections to 127.0.0.1. Restart TrueForge with OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"] (Contexo does this when it starts TrueForge itself).';
  } else if (err?.statusCode === 400) msg = `TrueForge rejected the request as invalid${bodyMessage(e) ? `: ${bodyMessage(e)}` : ' (check the key and fields)'}.`;
  else if (err?.statusCode === 424) msg = 'TrueForge could not validate the provider (check the key and base URL).';
  else if (err?.name === 'TrueForgeTimeoutError') msg = 'TrueForge did not answer in time.';
  else if (!err?.statusCode && (err?.cause?.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED/.test(String(err?.message)))) {
    msg = 'Cannot reach TrueForge (is it running?).';
  } else msg = String(err?.message ?? e);
  for (const s of secrets) if (s) msg = msg.split(s).join('***');
  return new Error(msg);
}

function matchesOwnedFields(observed: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(observed) && observed.length === expected.length &&
      expected.every((value, i) => matchesOwnedFields(observed[i], value));
  }
  if (expected !== null && typeof expected === 'object') {
    return observed !== null && typeof observed === 'object' && Object.entries(expected)
      .every(([key, value]) => matchesOwnedFields((observed as Record<string, unknown>)[key], value));
  }
  return observed === expected;
}

export function createAdmin(baseUrl: string, deps: AdminDeps = {}) {
  const client: AdminClient = deps.client ?? new TrueForge({ baseUrl: baseUrl.replace(/\/+$/, ''), timeoutInSeconds: 60 });
  const names = deps.agentNames ?? AGENT_NAMES;
  const log = deps.log ?? (() => undefined);

  async function wrap<T>(label: string, secrets: string[], fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const fe = friendlyError(e, secrets);
      log(`admin.${label} failed:`, fe.message);
      throw fe;
    }
  }

  return {
    async health(): Promise<boolean> {
      try {
        await client.server.getCapabilities({ timeoutInSeconds: 3, maxRetries: 0 });
        return true;
      } catch (e) {
        log('admin.health failed', friendlyError(e).message);
        return false;
      }
    },

    inspectRuntime() {
      return wrap('inspectRuntime', [], async () => {
        const options = { timeoutInSeconds: 6, maxRetries: 0 };
        const capabilities = await client.server.getCapabilities(options);
        const [skills, environments] = await Promise.allSettled([
          client.settings.skills.list(options),
          client.sandboxEnvironments?.list({ limit: 50 }, options),
        ]);
        return {
          sdk: '0.185.0',
          bundledRuntime: '0.185.1',
          advertised: capabilities,
          installedSkills: skills.status === 'fulfilled'
            ? skills.value.data.map(({ name, manifest }) => ({ name, type: manifest.type, ref: 'ref' in manifest ? manifest.ref : undefined }))
            : 'unavailable',
          sandboxEnvironments: environments.status === 'fulfilled' && environments.value
            ? { count: environments.value.data.length, more: environments.value.hasNextPage() }
            : 'unavailable',
          observedExecution: 'Inspect a recorded session for tool and skill execution evidence.',
        };
      });
    },

    listProviders(): Promise<ProviderList> {
      return wrap('listProviders', [], async () => {
        const [cat, conf] = await Promise.all([client.catalogs.modelProviders.list(), client.settings.modelProviders.list()]);
        const catalog: CatalogProviderInfo[] = cat.data.map((p) => ({
          type: p.type,
          custom: p.type === 'custom',
          models: 'models' in p ? p.models.map((m) => ({ modelId: m.modelId, name: m.name })) : [],
        }));
        return { catalog, configured: conf.data.map((c) => c.name) };
      });
    },

    /** Posts the key to TrueForge once. Well-known providers use the catalog's models; custom needs name+baseUrl+modelIds. */
    configureProvider(providerId: string, key: string, extra: ExtraProviderFields = {}): Promise<void> {
      return wrap('configureProvider', [key], async () => {
        // No key typed: keep the key TrueForge already stores for this provider. TrueForge returns it masked
        // ("sk--***REDACTED***-abc"); sending that mask back makes TrueForge keep the real key (verified live),
        // so Contexo never sees the real key.
        const savedName = providerId === 'custom' ? extra.name : providerId;
        let keptAuth: { apiKey: string } | undefined;
        if (!key) {
          const conf = await client.settings.modelProviders.list();
          const saved = conf.data.find((c) => c.name === savedName) as { manifest?: { auth?: { apiKey?: string } } } | undefined;
          if (saved?.manifest?.auth?.apiKey) keptAuth = { apiKey: saved.manifest.auth.apiKey };
          else if (providerId !== 'custom') throw new Error('An API key is required.');
        }
        const auth = key ? { apiKey: key } : keptAuth;
        const cat = await client.catalogs.modelProviders.list();
        const entry = cat.data.find((p) => p.type === providerId);
        if (!entry) throw new Error(`Unknown provider "${providerId}".`);
        let manifest: Parameters<typeof client.settings.modelProviders.createOrUpdate>[0]['manifest'];
        if (entry.type === 'custom') {
          if (!extra.name || !extra.baseUrl || !extra.modelIds?.length) throw new Error('Custom providers need a name, a base URL and at least one model id.');
          manifest = {
            type: 'custom',
            name: extra.name,
            baseUrl: extra.baseUrl,
            ...(auth ? { auth } : {}),
            models: extra.modelIds.map((id) => ({ modelId: id, name: id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase(), properties: {} })),
          };
        } else {
          const models = entry.models.map((m) => ({ modelId: m.modelId, name: m.name, properties: m.properties }));
          manifest = { type: entry.type, auth, models, ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}) } as typeof manifest;
        }
        await client.settings.modelProviders.createOrUpdate({ manifest });
        log(`admin.configureProvider ok: ${providerId}`);
      });
    },

    listModels(): Promise<string[]> {
      return wrap('listModels', [], async () => {
        const r = await client.models.list();
        return r.data.map((m) => modelFqn(m.provider.name, m.name));
      });
    },

    /** createOrUpdate is idempotent: safe to call at every activation (token/port may change). */
    ensureConnector(port: number, token: string): Promise<void> {
      return wrap('ensureConnector', [token], async () => {
        await client.settings.mcpServers.createOrUpdate({ manifest: buildConnectorManifest(port, token) });
        log('admin.ensureConnector ok');
      });
    },

    /** Creates or UPDATES one agent (primary or fallback) with the given model. */
    ensureAgent(kind: 'primary' | 'fallback', model: string, instructions: string, runtime?: { sandbox: string; skills?: string[] }): Promise<{ name: string; action: 'created' | 'updated' | 'unchanged' }> {
      return wrap('ensureAgent', [], async () => {
        const req = buildAgentRequest(kind, model, instructions, runtime);
        req.name = names[kind];
        const page = await client.agents.list({ agentName: req.name, limit: 50 });
        const existing = page.data.find((a) => a.name === req.name);
        const find = async () => (await client.agents.list({ agentName: req.name, limit: 50 }))
          .data.find(agent => agent.name === req.name);
        const matches = (agent: typeof existing) => !!agent && matchesOwnedFields(agent, {
          description: req.description, manifest: req.manifest,
        });
        if (matches(existing)) return { name: req.name, action: 'unchanged' };
        try {
          if (existing) {
            const current = existing.manifest;
            await client.agents.update(existing.id, {
              description: req.description,
              manifest: {
                ...current, ...req.manifest,
                model: { ...current.model, ...req.manifest.model },
                config: { ...current.config, ...req.manifest.config },
              },
            });
            return { name: req.name, action: 'updated' };
          }
          await client.agents.create(req);
          return { name: req.name, action: 'created' };
        } catch (error) {
          // A write can succeed when its response is lost. Use stable identity and read back.
          if (matches(await find().catch(() => undefined))) {
            return { name: req.name, action: 'unchanged' };
          }
          throw error;
        }
      });
    },

    /** Creates or UPDATES the contexo / contexo-fallback agents. */
    async ensureAgents(primaryModel: string, fallbackModel: string | undefined, instructions: string): Promise<Array<{ name: string; action: 'created' | 'updated' | 'unchanged' }>> {
      const out = [
        await this.ensureAgent('primary', primaryModel, instructions),
        await this.ensureAgent('fallback', fallbackModel || primaryModel, instructions),
      ];
      log('admin.ensureAgents', JSON.stringify(out));
      return out;
    },

    async register(options: { port: number; token: string; primaryModel: string; fallbackModel?: string; instructions: string; rotateToken?: boolean; runtime?: { sandbox: string; skills?: string[] } }) {
      const steps: Array<{ label: string; ok: boolean; detail?: string }> = [];
      const connector = { label: 'MCP connector contexo-editor', ok: false };
      try {
        const desired = buildConnectorManifest(options.port, options.token);
        const previous = await client.settings.mcpServers.get(CONNECTOR_NAME).catch((error: unknown) => {
          if ((error as { statusCode?: number })?.statusCode === 404) return undefined;
          throw error;
        });
        if (previous && (previous.data.manifest.type !== 'remote' ||
            previous.data.manifest.description !== desired.description)) {
          throw new Error('An existing connector uses the Contexo name with different ownership metadata.');
        }
        const sameUrl = previous?.data.manifest.type === 'remote' && previous.data.manifest.url === desired.url;
        let writeError: unknown;
        if (!sameUrl || options.rotateToken) {
          try {
            await this.ensureConnector(options.port, options.token);
          } catch (error) {
            // The masked read-back can verify a newly created URL, but not an explicit token rotation.
            if (options.rotateToken) throw error;
            writeError = error;
          }
        }
        const { data } = await client.settings.mcpServers.get(CONNECTOR_NAME).catch(error => {
          throw writeError ?? error;
        });
        if (data.manifest.type !== 'remote' || data.manifest.url !== desired.url) {
          throw writeError ?? new Error('Connector read-back did not match the requested URL.');
        }
        connector.ok = true;
        steps.push({ ...connector, detail: sameUrl && !options.rotateToken ? 'unchanged' : 'verified' });
      } catch (error) {
        steps.push({ ...connector, detail: friendlyError(error, [options.token]).message });
      }
      for (const kind of ['primary', 'fallback'] as const) {
        const label = 'Agent ' + names[kind];
        if (!connector.ok) {
          steps.push({ label, ok: false, detail: 'Blocked by connector registration' });
          continue;
        }
        try {
          const model = kind === 'primary' ? options.primaryModel : options.fallbackModel || options.primaryModel;
          const desired = buildAgentRequest(kind, model, options.instructions, options.runtime);
          desired.name = names[kind];
          const list = await client.agents.list({ agentName: desired.name });
          const previous = list.data.find(agent => agent.name === desired.name);
          if (previous && !previous.manifest.mcpServers?.some(server => server.name === CONNECTOR_NAME)) {
            throw new Error('An existing agent uses the Contexo name without the Contexo connector.');
          }
          const result = await this.ensureAgent(kind, model, options.instructions, options.runtime);
          const observed = (await client.agents.list({ agentName: desired.name })).data.find(agent => agent.name === desired.name);
          if (!observed || observed.manifest.model.name !== model ||
              !observed.manifest.mcpServers?.some(server => server.name === CONNECTOR_NAME)) {
            throw new Error('Agent read-back did not match the requested model and connector.');
          }
          if (options.runtime && observed.manifest.config?.sandbox?.environmentName !== options.runtime.sandbox) {
            throw new Error('Agent read-back did not match the requested sandbox.');
          }
          steps.push({ label, ok: true, detail: result.action });
        } catch (error) {
          steps.push({ label, ok: false, detail: friendlyError(error, [options.token]).message });
        }
      }
      return steps;
    },

    /** "Test resilience": (re)creates the deliberately broken custom provider. */
    ensureBrokenProvider(): Promise<void> {
      return wrap('ensureBrokenProvider', [], async () => {
        await client.settings.modelProviders.createOrUpdate({ manifest: buildBrokenProviderManifest() });
        log('admin.ensureBrokenProvider ok');
      });
    },

    /** Deletes the broken provider; an already-absent provider is fine. */
    deleteBrokenProvider(): Promise<void> {
      return wrap('deleteBrokenProvider', [], async () => {
        try {
          await client.settings.modelProviders.delete(BROKEN_PROVIDER);
        } catch (e) {
          if ((e as { statusCode?: number })?.statusCode !== 404) throw e;
        }
        log('admin.deleteBrokenProvider ok');
      });
    },

    /** Read-only registration check. */
    async inspect(): Promise<{ connectorOk: boolean; agentsOk: boolean; agentModels: { primary?: string; fallback?: string } }> {
      let connectorOk = false;
      try { await client.settings.mcpServers.get(CONNECTOR_NAME); connectorOk = true; } catch { /* absent */ }
      const agentModels: { primary?: string; fallback?: string } = {};
      try {
        for (const kind of ['primary', 'fallback'] as const) {
          const page = await client.agents.list({ agentName: names[kind], limit: 50 });
          agentModels[kind] = page.data.find((a) => a.name === names[kind])?.manifest.model.name;
        }
      } catch { /* TrueForge down */ }
      return { connectorOk, agentsOk: !!agentModels.primary && !!agentModels.fallback, agentModels };
    },
  };
}

export type TrueForgeAdmin = ReturnType<typeof createAdmin>;
