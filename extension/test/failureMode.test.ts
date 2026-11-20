/**
 * failureMode.test.ts - "Test resilience" toggle: broken-provider manifest, simulate and restore ordering/persistence.
 */
import { describe, expect, it } from 'vitest';
import { createFailureSim, expectedPrimaryModel } from '../src/run/failureMode';
import { BROKEN_BASE_URL, BROKEN_PROVIDER, brokenModelFqn, buildAgentRequest, buildBrokenProviderManifest } from '../src/run/manifests';

function fakes(primary = 'openai/gpt-x') {
  const calls: string[] = [];
  let flag = false;
  const sim = createFailureSim({
    admin: {
      async ensureBrokenProvider() { calls.push('provider:create'); },
      async deleteBrokenProvider() { calls.push('provider:delete'); },
      async ensureAgent(kind, model) { calls.push(`agent:${kind}:${model}`); },
    },
    store: { get: () => flag, set: (v) => { flag = v; calls.push(`flag:${v}`); } },
    primaryModel: () => primary,
    instructions: 'x',
  });
  return { sim, calls, flag: () => flag };
}

describe('broken provider manifest', () => {
  const m = buildBrokenProviderManifest();
  it('is a custom provider with an unreachable loopback endpoint and one dummy model', () => {
    expect(m).toMatchObject({ type: 'custom', name: BROKEN_PROVIDER, baseUrl: BROKEN_BASE_URL });
    expect(BROKEN_BASE_URL).toBe('http://127.0.0.1:9/v1');
    expect(m.models).toHaveLength(1);
    expect(brokenModelFqn()).toBe(`${BROKEN_PROVIDER}/${m.models[0].name}`);
  });
  it('the primary agent request on the broken model keeps the tools and approvals intact', () => {
    const r = buildAgentRequest('primary', brokenModelFqn(), 'instr');
    expect(r.name).toBe('contexo');
    expect(r.manifest.model.name).toBe(brokenModelFqn());
    expect(r.manifest.mcpServers[0].requireApprovalForTools).toEqual(['propose_write', 'run_command']);
  });
});

describe('failure simulation', () => {
  it('simulate: creates the provider, re-registers ONLY the primary on the broken model, then persists the flag', async () => {
    const { sim, calls, flag } = fakes();
    await sim.simulate();
    expect(calls).toEqual(['provider:create', `agent:primary:${brokenModelFqn()}`, 'flag:true']);
    expect(flag()).toBe(true);
    expect(sim.active).toBe(true);
  });
  it('restore: primary back on the real model BEFORE the provider is deleted, then flag cleared', async () => {
    const { sim, calls } = fakes('openai/gpt-x');
    await sim.simulate();
    calls.length = 0;
    await sim.restore();
    expect(calls).toEqual(['agent:primary:openai/gpt-x', 'provider:delete', 'flag:false']);
    expect(sim.active).toBe(false);
  });
  it('restore without a primary model fails and leaves the mode on', async () => {
    const { sim } = fakes('');
    await sim.simulate();
    await expect(sim.restore()).rejects.toThrow(/primary model/i);
    expect(sim.active).toBe(true);
  });
  it('a failed simulate never sets the flag', async () => {
    const bad = createFailureSim({
      admin: { ensureBrokenProvider: async () => { throw new Error('nope'); }, deleteBrokenProvider: async () => undefined, ensureAgent: async () => undefined },
      store: { get: () => false, set: () => { throw new Error('must not be called'); } },
      primaryModel: () => 'a/b', instructions: 'x',
    });
    await expect(bad.simulate()).rejects.toThrow('nope');
  });
  it('expectedPrimaryModel follows the mode (so setup does not flag the broken agent as unregistered)', () => {
    expect(expectedPrimaryModel(true, 'a/b')).toBe(brokenModelFqn());
    expect(expectedPrimaryModel(false, 'a/b')).toBe('a/b');
  });
});
