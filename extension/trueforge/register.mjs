// Registers the Contexo MCP connector and both agents in a running TrueForge via the SDK.
// Usage (from extension/):  CONTEXO_TOKEN=... PRIMARY_MODEL=provider/model FALLBACK_MODEL=provider/model node trueforge/register.mjs
// Optional: TRUEFORGE_URL (default http://localhost:8790), CONTEXO_PORT (default 8791).
// Existing resources with the same name are left alone (create fails with a conflict; delete in the UI to redo).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const dir = dirname(fileURLToPath(import.meta.url));
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(1); } return v; };
const token = need('CONTEXO_TOKEN');
const models = { contexo: need('PRIMARY_MODEL'), 'contexo-fallback': need('FALLBACK_MODEL') };
const port = process.env.CONTEXO_PORT || '8791';
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL || 'http://localhost:8790', timeoutInSeconds: 60 });
const readJson = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const instructions = readFileSync(join(dir, 'instructions.md'), 'utf8');

const mcp = readJson('contexo-editor.mcp.json');
delete mcp.$comment;
mcp.manifest.url = `http://127.0.0.1:${port}/mcp`;
mcp.manifest.auth.headers['X-Contexo-Token'] = token;
try { await client.settings.mcpServers.create(mcp); console.log('created connector contexo-editor'); }
catch (e) { console.warn('connector:', e?.message ?? e); }

for (const f of ['contexo.agent.json', 'contexo-fallback.agent.json']) {
  const a = readJson(f);
  delete a.$comment;
  a.manifest.instructions = instructions;
  a.manifest.model.name = models[a.name];
  try { await client.agents.create(a); console.log('created agent', a.name); }
  catch (e) { console.warn(`agent ${a.name}:`, e?.message ?? e); }
}
