/**
 * mcp/server.ts - C3 MCP Streamable HTTP server for TrueForge.
 *
 * Exports:
 *  - startServer({ port, token, registerTools }): node:http server on 127.0.0.1:port, path /mcp.
 *    STATELESS mode: a fresh McpServer + StreamableHTTPServerTransport (sessionIdGenerator undefined,
 *    JSON responses) per POST; registerTools(server) is called for each new McpServer. GET/DELETE -> 405.
 *    401 unless header x-contexo-token matches. EADDRINUSE -> error that mentions `contexo.mcpPort`.
 *  - getOrCreateToken(secrets): random 32-byte hex under secret key 'contexo.mcpToken'.
 *  - resolveInWorkspace(p): workspace-relative path -> absolute path inside workspaceFolders[0];
 *    throws on absolute paths, '..' escapes, '.git/' segments. Pure core: resolveUnder(root, p).
 *  - capOutput(text, max=16000): truncate tool output.
 *
 * Revocation after Stop is NOT done here: each tool handler checks runs.isToolCallAllowed().
 * vscode is imported lazily (inside getOrCreateToken/resolveInWorkspace) so the pure helpers can be
 * unit-tested with Vitest.
 * Depends on: @modelcontextprotocol/sdk, node:http, node:crypto, node:path. Depended on by: extension.
 */
import { workspaceRoot } from '../shell/workspaceRoot';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RunRoute } from './runRoutes';
import type * as vscode from 'vscode';

/** Lazy log so the pure helpers stay importable without 'vscode' (Vitest). */
function log(...args: unknown[]): void {
  void import('../log').then((m) => m.log(...args)).catch(() => undefined);
}

export interface McpHandle { port: number; url: string; stop(): Promise<void> }

const MCP_PATH = '/mcp';
const AGENT_PATH = '/mcp/agent';
const TOKEN_KEY = 'contexo.mcpToken';

export function capOutput(s: string, max = 16000): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** Pure path guard: resolves workspace-relative `p` under `root`, or throws. Returns an absolute path. */
export function resolveUnder(root: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('PATH_INVALID: empty path');
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || path.posix.isAbsolute(p)) {
    throw new Error(`PATH_INVALID: absolute paths are not allowed (${p}); use a workspace-relative path`);
  }
  const segments = p.split(/[\\/]+/);
  if (segments.includes('..')) throw new Error(`PATH_INVALID: '..' is not allowed (${p})`);
  if (segments.includes('.git')) throw new Error(`PATH_INVALID: .git is not accessible (${p})`);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`PATH_INVALID: path escapes the workspace (${p})`);
  }
  return abs;
}

export async function assertNativeWorkspacePath(root: string, relative: string): Promise<string> {
  const target = resolveUnder(root, relative);
  const rootReal = await realpath(root);
  // A new file can have new parents. Resolve the closest existing path before allowing it.
  let existing = target;
  while (existing !== root) {
    try {
      await lstat(existing);
      const resolved = await realpath(existing);
      if (resolved !== rootReal) resolveUnder(rootReal, path.relative(rootReal, resolved));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An existing dangling link is not a candidate for creating a file.
      if (await lstat(existing).then(() => true, () => false)) throw error;
      existing = path.dirname(existing);
    }
  }
  return target;
}

export function resolveInWorkspace(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof vscode;
  const folder = workspaceRoot();
  if (!folder) throw new Error('NO_WORKSPACE: open a folder first');
  return resolveUnder(folder.uri.fsPath, p);
}

export async function getOrCreateToken(secrets: vscode.SecretStorage, key = TOKEN_KEY): Promise<string> {
  const existing = await secrets.get(key);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  await secrets.store(key, token);
  return token;
}

function tokenOk(header: string | string[] | undefined, token: string): boolean {
  const got = Array.isArray(header) ? header[0] : header;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('MCP request exceeds 1 MiB.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

export function startServer(o: {
  port: number;
  token: string;
  registerTools: (server: McpServer, route?: RunRoute) => void;
  lookupRoute?: (connector: string) => RunRoute | undefined;
  agent?: { token: string; registerTools: (server: McpServer) => void };
}): Promise<McpHandle> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const connector = /^\/mcp\/(contexo-run-[a-f0-9]{24})$/.exec(url.pathname)?.[1];
      const route = connector ? o.lookupRoute?.(connector) : undefined;
      const agent = url.pathname === AGENT_PATH ? o.agent : undefined;
      if (!agent && !route && url.pathname !== MCP_PATH) return sendJson(res, 404, { error: 'not found' });
      if (!tokenOk(req.headers['x-contexo-token'], agent?.token ?? route?.token ?? o.token)) return sendJson(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') {
        return sendJson(res, 405, {
          jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null,
        }, { allow: 'POST' });
      }
      const body = await readBody(req);
      const mcp = new McpServer({ name: 'contexo-editor', version: '0.1.0' });
      if (agent) agent.registerTools(mcp);
      else o.registerTools(mcp, route);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('mcp request error', String(e));
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  return new Promise<McpHandle>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Contexo MCP port ${o.port} is already in use. Change the 'contexo.mcpPort' setting (and update the MCP URL in TrueForge).`));
      } else {
        reject(err);
      }
    });
    server.listen(o.port, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}${MCP_PATH}`;
      log('mcp listening', url);
      resolve({
        port,
        url,
        stop: () => new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
