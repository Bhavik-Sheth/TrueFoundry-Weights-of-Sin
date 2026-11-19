import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_NAMES, buildAgentRequest, buildConnectorManifest, modelFqn, nodeVersionOk, parseNodeVersion } from '../src/run/manifests';

const dir = join(__dirname, '..', 'trueforge');
const readJson = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const camel = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(camel)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$comment').map(([k, x]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), camel(x)]))
    : v;

describe('agent manifests', () => {
  it('match trueforge/*.agent.json (camelCased) with model + instructions substituted', () => {
    for (const [kind, file] of [['primary', 'contexo.agent.json'], ['fallback', 'contexo-fallback.agent.json']] as const) {
      const json = camel(readJson(file)) as any;
      json.manifest.model.name = 'p/m';
      json.manifest.instructions = 'INSTR';
      expect(buildAgentRequest(kind, 'p/m', 'INSTR')).toEqual(json);
    }
  });
  it('has approval for propose_write/run_command and deferred tools (preload false + preloadTools)', () => {
    const m = buildAgentRequest('primary', 'openai/x', 'i').manifest.mcpServers[0];
    expect(m.requireApprovalForTools).toEqual(['propose_write', 'run_command']);
    expect(m.preload).toBe(false);
    expect(m.preloadTools).not.toContain('run_command');
    expect(AGENT_NAMES.primary).toBe('contexo');
  });
  it('connector matches contexo-editor.mcp.json with port and token', () => {
    const json = (camel(readJson('contexo-editor.mcp.json')) as any).manifest;
    json.url = 'http://127.0.0.1:9000/mcp';
    json.auth.headers = { 'X-Contexo-Token': 'tok' };
    expect(buildConnectorManifest(9000, 'tok')).toEqual(json);
  });
});

describe('node version check', () => {
  it('parses', () => {
    expect(parseNodeVersion('v22.17.1\n')).toEqual([22, 17, 1]);
    expect(parseNodeVersion('nope')).toBeUndefined();
  });
  it.each([['v22.14.0', true], ['v22.13.9', false], ['v20.11.0', false], ['v23.0.0', true], ['v24.1.2', true], ['garbage', false]])('%s -> %s', (v, ok) => {
    expect(nodeVersionOk(v)).toBe(ok);
  });
  it('modelFqn', () => {
    expect(modelFqn('openai', 'gpt')).toBe('openai/gpt');
    expect(modelFqn('openai', 'openai/gpt')).toBe('openai/gpt');
  });
});
