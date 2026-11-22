/**
 * run/manifests.ts - pure builders for the TrueForge connector and agent manifests (no vscode, no SDK import).
 *
 * Mirrors extension/trueforge/*.json + register.mjs in the SDK's camelCase shape (the SDK serialises to
 * the snake_case wire format). test/manifests.test.ts compares these against the JSON files so they cannot drift.
 *
 * Exports: CONNECTOR_NAME, AGENT_NAMES, BROKEN_* / buildBrokenProviderManifest / brokenModelFqn, buildConnectorManifest, buildAgentRequest, parseNodeVersion, nodeVersionOk,
 *          modelFqn.
 * Depended on by: run/trueforgeAdmin, run/trueforgeProcess, tests.
 */

export const CONNECTOR_NAME = 'contexo-editor';
export const AGENT_NAMES = { primary: 'contexo', fallback: 'contexo-fallback' } as const;

/** "Test resilience": a custom provider whose endpoint refuses connections (port 9, loopback), so model calls fail fast. */
export const BROKEN_PROVIDER = 'contexo-broken';
export const BROKEN_MODEL_ID = 'broken-model';
export const BROKEN_BASE_URL = 'http://127.0.0.1:9/v1';

export function buildBrokenProviderManifest() {
  return {
    type: 'custom' as const,
    name: BROKEN_PROVIDER,
    baseUrl: BROKEN_BASE_URL,
    auth: { apiKey: 'dummy-not-a-real-key' },
    models: [{ modelId: BROKEN_MODEL_ID, name: BROKEN_MODEL_ID, properties: {} }],
  };
}

export const brokenModelFqn = () => `${BROKEN_PROVIDER}/${BROKEN_MODEL_ID}`;

export function buildConnectorManifest(port: number, token: string) {
  return {
    type: 'remote' as const,
    name: CONNECTOR_NAME,
    description: 'Contexo VS Code editor tools: search, read, assemble context, propose edits, run allowlisted commands.',
    url: `http://127.0.0.1:${port}/mcp`,
    auth: { type: 'header' as const, headers: { 'X-Contexo-Token': token } },
  };
}

export interface AgentRuntime {
  sandbox?: string;
  skills?: string[];
  maxOutputTokens?: number;
}

export interface AgentRequest {
  name: string;
  description: string;
  manifest: {
    model: { name: string; params: { temperature: number; maxTokens?: number } };
    instructions: string;
    mcpServers: Array<{
      name: string;
      enableTools: string[];
      requireApprovalForTools: string[];
      preload: boolean;
      preloadTools: string[];
    }>;
    skills?: Array<{ name: string }>;
    config: { sandbox?: { enabled: boolean; environmentName: string }; iterationLimit: number; contextManagement: { compaction: { enabled: boolean } }; dynamicSubAgents: { enabled: boolean } };
  };
}

export function buildAgentRequest(kind: 'primary' | 'fallback', model: string, instructions: string, runtime?: AgentRuntime): AgentRequest {
  return {
    name: AGENT_NAMES[kind],
    description:
      kind === 'primary'
        ? 'Contexo primary agent: safe Python repo edits through editor MCP tools.'
        : 'Contexo fallback agent (same tools and instructions, different model).',
    manifest: {
      model: { name: model, params: { temperature: 0.2, ...(runtime?.maxOutputTokens ? { maxTokens: runtime.maxOutputTokens } : {}) } },
      instructions,
      mcpServers: [
        {
          name: CONNECTOR_NAME,
          enableTools: ['@all'],
          requireApprovalForTools: ['propose_write', 'run_command'],
          preload: false,
          preloadTools: ['search_workspace', 'read_file', 'assemble_context', 'propose_write'],
        },
      ],
      ...(runtime?.skills?.length ? { skills: runtime.skills.map(name => ({ name })) } : {}),
      config: {
        ...(runtime?.sandbox ? { sandbox: { enabled: true, environmentName: runtime.sandbox } } : {}),
        iterationLimit: 40,
        contextManagement: { compaction: { enabled: true } },
        // Named subagents unsupported in trueforge-sdk 0.185.0 (dynamic only); see docs/FEATURE_PLAN.md P9.
        dynamicSubAgents: { enabled: true },
      },
    },
  };
}

/** `node --version` output ("v22.17.1") -> [major, minor, patch] or undefined. */
export function parseNodeVersion(out: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(out.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** TrueForge needs Node >= 22.14. */
export function nodeVersionOk(out: string): boolean {
  const v = parseNodeVersion(out);
  if (!v) return false;
  return v[0] > 22 || (v[0] === 22 && v[1] >= 14);
}

/** Catalog/available models are addressed as `provider/model`. */
export function modelFqn(provider: string, name: string): string {
  return name.includes('/') ? name : `${provider}/${name}`;
}
