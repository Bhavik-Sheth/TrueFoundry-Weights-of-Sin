import { describe, expect, it } from 'vitest';
import { computeSetupStatus, isSetupComplete } from '../src/shell/setup';
import type { SetupInputs } from '../src/shell/setup';

const base: SetupInputs = {
  trueforge: 'running', providersConfigured: ['openai'], models: ['openai/a', 'anthropic/b'],
  primaryModel: 'openai/a', fallbackModel: 'anthropic/b', connectorOk: true, agentsOk: true, mcpOk: true, indexReady: true,
};

describe('setup status', () => {
  it('is complete when running, models, primary, connector and agents are present', () => {
    expect(isSetupComplete(computeSetupStatus(base))).toBe(true);
  });
  it.each([
    ['trueforge down', { trueforge: 'down' as const }],
    ['node missing', { trueforge: 'node-missing' as const }],
    ['starting', { trueforge: 'starting' as const }],
    ['no models', { models: [] }],
    ['no primary', { primaryModel: '' }],
    ['primary not available', { primaryModel: 'gone/x' }],
    ['connector missing', { connectorOk: false }],
    ['agents missing', { agentsOk: false }],
  ])('is incomplete: %s', (_n, patch) => {
    expect(isSetupComplete(computeSetupStatus({ ...base, ...patch }))).toBe(false);
  });
  it('hides remote facts when TrueForge is not running; mcp/index pass through', () => {
    const s = computeSetupStatus({ ...base, trueforge: 'down' });
    expect(s.models).toEqual([]);
    expect(s.connectorOk).toBe(false);
    expect(s.mcpOk).toBe(true);
    expect(s.indexReady).toBe(true);
  });
  it('empty fallback is undefined', () => {
    expect(computeSetupStatus({ ...base, fallbackModel: '' }).fallbackModel).toBeUndefined();
  });
});
