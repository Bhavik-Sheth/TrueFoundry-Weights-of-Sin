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

describe('setup flow needs no TrueForge web UI', () => {
  it('completes from API facts alone: the status has no UI/session URL field', () => {
    const s = computeSetupStatus(base);
    expect(isSetupComplete(s)).toBe(true);
    expect(Object.keys(s).some((k) => /url/i.test(k))).toBe(false);
  });
  it('the webview has no required "Open TrueForge" step (only the advanced link in Settings)', async () => {
    const { readFileSync } = await import('node:fs');
    const setup = readFileSync(new URL('../webview/src/SetupView.tsx', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../webview/src/ChatTab.tsx', import.meta.url), 'utf8');
    expect(setup).not.toMatch(/>\s*Open TrueForge\s*</);
    expect(chat).not.toMatch(/Open in TrueForge/);
    expect((setup.match(/openTrueForge/g) ?? []).length).toBe(1);
    expect(setup).toMatch(/Advanced: open TrueForge web UI/);
  });
});

import { repickModels } from '../src/shell/setup';

describe('repickModels', () => {
  const models = ['openrouter/google-gemma-4-31b-it-free', 'openrouter/nvidia-nemotron-free', 'google-gemini/gemini-3-5-flash'];
  it('keeps valid choices', () => {
    expect(repickModels(models, models[0], models[2], 'openrouter')).toBeUndefined();
  });
  it('replaces models that were removed, using the saved provider (two different ones)', () => {
    expect(repickModels(models, 'openrouter/recraft-free', 'openrouter/recraft-free', 'openrouter')).toEqual({
      primary: 'openrouter/google-gemma-4-31b-it-free',
      fallback: 'openrouter/nvidia-nemotron-free',
    });
  });
  it('keeps a still-valid fallback', () => {
    expect(repickModels(models, 'openrouter/gone', models[2], 'openrouter')).toEqual({ primary: models[0], fallback: models[2] });
  });
});
