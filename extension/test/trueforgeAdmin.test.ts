import { describe, expect, it, vi } from 'vitest';
import { createAdmin } from '../src/run/trueforgeAdmin';
import type { AdminClient } from '../src/run/trueforgeAdmin';

const KEY = 'sk-SECRET-123456';

function fake(opts: { agents?: Array<{ id: string; name: string }>; providerError?: unknown } = {}) {
  const calls = { create: [] as any[], update: [] as any[], provider: [] as any[], connector: [] as any[] };
  const client = {
    server: { getCapabilities: vi.fn(async () => ({})) },
    models: { list: vi.fn(async () => ({ data: [{ modelId: 'x', name: 'gpt-x', provider: { name: 'openai' }, properties: {} }] })) },
    catalogs: {
      modelProviders: {
        list: vi.fn(async () => ({
          data: [
            { type: 'openai', models: [{ modelId: 'gpt-x', name: 'gpt-x', properties: {} }] },
            { type: 'custom', supportedReasoningEfforts: [] },
          ],
        })),
      },
    },
    settings: {
      modelProviders: {
        list: vi.fn(async () => ({ data: [{ name: 'openai', manifest: {} }] })),
        createOrUpdate: vi.fn(async (r: any) => { calls.provider.push(r); if (opts.providerError) throw opts.providerError; return { data: {} }; }),
      },
      mcpServers: {
        createOrUpdate: vi.fn(async (r: any) => { calls.connector.push(r); return { data: {} }; }),
        get: vi.fn(async () => ({ data: {} })),
      },
    },
    agents: {
      list: vi.fn(async (q: { agentName?: string }) => ({ data: (opts.agents ?? []).filter((a) => a.name === q.agentName).map((a) => ({ ...a, manifest: { model: { name: 'old/m' } } })) })),
      create: vi.fn(async (r: any) => { calls.create.push(r); return { data: {} }; }),
      update: vi.fn(async (id: string, r: any) => { calls.update.push({ id, r }); return { data: {} }; }),
    },
  };
  return { client: client as unknown as AdminClient, calls };
}

describe('trueforgeAdmin', () => {
  it('ensureAgents creates when absent', async () => {
    const { client, calls } = fake();
    const admin = createAdmin('http://x', { client });
    const r = await admin.ensureAgents('openai/a', 'anthropic/b', 'INSTR');
    expect(r.map((x) => x.action)).toEqual(['created', 'created']);
    expect(calls.create.map((c) => [c.name, c.manifest.model.name, c.manifest.instructions])).toEqual([
      ['contexo', 'openai/a', 'INSTR'], ['contexo-fallback', 'anthropic/b', 'INSTR'],
    ]);
    expect(calls.update).toHaveLength(0);
  });
  it('ensureAgents UPDATES existing agents (idempotent)', async () => {
    const { client, calls } = fake({ agents: [{ id: 'id1', name: 'contexo' }, { id: 'id2', name: 'contexo-fallback' }] });
    const r = await createAdmin('http://x', { client }).ensureAgents('openai/a', undefined, 'I');
    expect(r.map((x) => x.action)).toEqual(['updated', 'updated']);
    expect(calls.update.map((u) => u.id)).toEqual(['id1', 'id2']);
    expect(calls.update[1].r.manifest.model.name).toBe('openai/a'); // fallback defaults to primary
    expect(calls.create).toHaveLength(0);
  });
  it('ensureConnector upserts with url and token header', async () => {
    const { client, calls } = fake();
    await createAdmin('http://x', { client }).ensureConnector(8791, 'tok');
    expect(calls.connector[0].manifest.url).toBe('http://127.0.0.1:8791/mcp');
    expect(calls.connector[0].manifest.auth.headers['X-Contexo-Token']).toBe('tok');
  });
  it('lists providers and models, health true', async () => {
    const { client } = fake();
    const admin = createAdmin('http://x', { client });
    const p = await admin.listProviders();
    expect(p.configured).toEqual(['openai']);
    expect(p.catalog.map((c) => [c.type, c.custom])).toEqual([['openai', false], ['custom', true]]);
    expect(await admin.listModels()).toEqual(['openai/gpt-x']);
    expect(await admin.health()).toBe(true);
  });
  it('configureProvider posts the key to TrueForge with catalog models', async () => {
    const { client, calls } = fake();
    await createAdmin('http://x', { client }).configureProvider('openai', KEY);
    expect(calls.provider[0].manifest).toMatchObject({ type: 'openai', auth: { apiKey: KEY }, models: [{ modelId: 'gpt-x' }] });
  });
  it('never leaks the key in thrown errors or logs', async () => {
    const logs: string[] = [];
    const bad = Object.assign(new Error(`upstream said bad key ${KEY}`), { statusCode: 500 });
    const { client } = fake({ providerError: bad });
    const admin = createAdmin('http://x', { client, log: (...a) => logs.push(a.map(String).join(' ')) });
    const err = await admin.configureProvider('openai', KEY).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.length).toBeGreaterThan(0);
    const ok = fake();
    const logs2: string[] = [];
    await createAdmin('http://x', { client: ok.client, log: (...a) => logs2.push(a.map(String).join(' ')) }).configureProvider('openai', KEY);
    expect(logs2.join('\n')).not.toContain(KEY);
  });
  it('maps unreachable TrueForge to a readable message and health false', async () => {
    const { client } = fake();
    const refused = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    (client.server as any).getCapabilities = vi.fn(refused);
    (client.models as any).list = vi.fn(refused);
    const admin = createAdmin('http://x', { client });
    expect(await admin.health()).toBe(false);
    await expect(admin.listModels()).rejects.toThrow(/Cannot reach TrueForge/);
  });
});
