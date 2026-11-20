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
export type AdminClient = Pick<TrueForge, 'server' | 'models' | 'settings' | 'catalogs' | 'agents'>;

export interface AdminDeps { client?: AdminClient; log?: (...a: unknown[]) => void }

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

export function createAdmin(baseUrl: string, deps: AdminDeps = {}) {
  const client: AdminClient = deps.client ?? new TrueForge({ baseUrl: baseUrl.replace(/\/+$/, ''), timeoutInSeconds: 60 });
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
        if (!key && providerId !== 'custom') throw new Error('An API key is required.');
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
            ...(key ? { auth: { apiKey: key } } : {}),
            models: extra.modelIds.map((id) => ({ modelId: id, name: id.replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase(), properties: {} })),
          };
        } else {
          const models = entry.models.map((m) => ({ modelId: m.modelId, name: m.name, properties: m.properties }));
          manifest = { type: entry.type, auth: { apiKey: key }, models, ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}) } as typeof manifest;
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
    ensureAgent(kind: 'primary' | 'fallback', model: string, instructions: string): Promise<{ name: string; action: 'created' | 'updated' }> {
      return wrap('ensureAgent', [], async () => {
        const req = buildAgentRequest(kind, model, instructions);
        const page = await client.agents.list({ agentName: req.name, limit: 50 });
        const existing = page.data.find((a) => a.name === req.name);
        if (existing) {
          await client.agents.update(existing.id, { description: req.description, manifest: req.manifest });
          return { name: req.name, action: 'updated' as const };
        }
        await client.agents.create(req);
        return { name: req.name, action: 'created' as const };
      });
    },

    /** Creates or UPDATES the contexo / contexo-fallback agents. */
    async ensureAgents(primaryModel: string, fallbackModel: string | undefined, instructions: string): Promise<Array<{ name: string; action: 'created' | 'updated' }>> {
      const out = [
        await this.ensureAgent('primary', primaryModel, instructions),
        await this.ensureAgent('fallback', fallbackModel || primaryModel, instructions),
      ];
      log('admin.ensureAgents', JSON.stringify(out));
      return out;
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
          const page = await client.agents.list({ agentName: AGENT_NAMES[kind], limit: 50 });
          agentModels[kind] = page.data.find((a) => a.name === AGENT_NAMES[kind])?.manifest.model.name;
        }
      } catch { /* TrueForge down */ }
      return { connectorOk, agentsOk: !!agentModels.primary && !!agentModels.fallback, agentModels };
    },
  };
}

export type TrueForgeAdmin = ReturnType<typeof createAdmin>;
