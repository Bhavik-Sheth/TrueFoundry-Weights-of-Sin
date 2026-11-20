/**
 * run/trueforgeProcess.ts - auto-start of a local TrueForge (no vscode import; fully injectable).
 *
 * Exports:
 *  - isLocalUrl(url), portOf(url)
 *  - checkNode(): runs `node --version`, returns { ok, version }.
 *  - ensureTrueForge(o): if o.ping() succeeds -> { startedByUs:false }. Else, when the URL is localhost, Node >= 22.14
 *    and autoStart: spawns `npx -y @truefoundry/trueforge@latest --port <port>` (shell:true for npx.cmd on Windows; the only
 *    interpolated value is a numeric port), pipes output to o.log, polls ping until healthy (default 120 s).
 *    Reports state via o.onState ('starting' | 'running' | 'down' | 'node-missing').
 *  - handle.stop(): tree-kills the child, only if WE started it.
 * Depends on: node:child_process, tree-kill, run/manifests. Depended on by: shell/setupController, extension.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import { nodeVersionOk } from './manifests';

export type TfProcState = 'starting' | 'running' | 'down' | 'node-missing';

export interface TfProcHandle {
  startedByUs: boolean;
  state: TfProcState;
  detail?: string;
  stop(): Promise<void>;
}

export interface EnsureOpts {
  url: string;
  autoStart: boolean;
  ping: () => Promise<boolean>;
  log: (...a: unknown[]) => void;
  onState?: (s: TfProcState, detail?: string) => void;
  timeoutMs?: number;
  pollMs?: number;
  /** test seams */
  nodeVersion?: () => Promise<string>;
  spawnFn?: (port: number) => ChildProcess;
}

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export function portOf(url: string): number {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

export function systemNodeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('node', ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export async function checkNode(read: () => Promise<string> = systemNodeVersion): Promise<{ ok: boolean; version?: string }> {
  try {
    const v = (await read()).trim();
    return { ok: nodeVersionOk(v), version: v };
  } catch {
    return { ok: false };
  }
}

function defaultSpawn(port: number): ChildProcess {
  return spawn('npx', ['-y', '@truefoundry/trueforge@latest', '--port', String(Math.trunc(port))], {
    shell: true,
    detached: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // TrueForge blocks outbound URLs to loopback by default (SSRF guard); the Contexo MCP
    // connector lives on 127.0.0.1, so allow exactly that host.
    env: { ...process.env, OUTBOUND_URL_ALLOWED_HOSTS: LOOPBACK_ALLOWLIST },
  });
}

/** Value for TrueForge's OUTBOUND_URL_ALLOWED_HOSTS so it can reach the local Contexo MCP server. */
export const LOOPBACK_ALLOWLIST = '["127.0.0.1"]';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses `netstat -ano` (Windows) output: PIDs listening on the given TCP port. */
export function parseNetstatPids(out: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP' || cols[3].toUpperCase() !== 'LISTENING') continue;
    if (!cols[1].endsWith(`:${port}`)) continue;
    const pid = Number(cols[4]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** PIDs of processes listening on a local TCP port (netstat on Windows, lsof elsewhere). */
export function findListeningPids(port: number): Promise<number[]> {
  const p = Math.trunc(port);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 10000 }, (err, stdout) =>
        resolve(err ? [] : parseNetstatPids(String(stdout), p)));
    } else {
      execFile('lsof', ['-t', '-i', `tcp:${p}`, '-sTCP:LISTEN'], { timeout: 10000 }, (err, stdout) =>
        resolve(err ? [] : String(stdout).split(/\s+/).map(Number).filter((n) => n > 0)));
    }
  });
}

/** Stops whatever TrueForge is listening on the local port (also one Contexo did not start). Returns PIDs stopped. */
export async function stopTrueForgeOnPort(port: number, log: (...a: unknown[]) => void): Promise<number[]> {
  const pids = await findListeningPids(port);
  for (const pid of pids) {
    log(`trueforge: stopping process ${pid} on port ${port}`);
    await new Promise<void>((res) => treeKill(pid, 'SIGTERM', () => res()));
  }
  return pids;
}

export async function ensureTrueForge(o: EnsureOpts): Promise<TfProcHandle> {
  const noop = async () => undefined;
  const set = (s: TfProcState, detail?: string): TfProcHandle => {
    o.onState?.(s, detail);
    return { startedByUs: false, state: s, detail, stop: noop };
  };

  if (await o.ping()) return set('running');
  if (!o.autoStart) return set('down', 'TrueForge is not running and auto-start is off.');
  if (!isLocalUrl(o.url)) return set('down', 'TrueForge is not reachable at the configured (non-local) URL.');

  const node = await checkNode(o.nodeVersion);
  if (!node.ok) {
    return set('node-missing', node.version
      ? `Node ${node.version} found; TrueForge needs Node 22.14 or newer (https://nodejs.org).`
      : 'Node.js was not found on PATH; TrueForge needs Node 22.14 or newer (https://nodejs.org).');
  }

  const port = portOf(o.url);
  o.onState?.('starting', 'Starting TrueForge (the first run downloads it, this can take a minute)...');
  o.log(`trueforge: spawning npx @truefoundry/trueforge@latest --port ${port}`);
  const child = (o.spawnFn ?? defaultSpawn)(port);
  let exited = false;
  child.stdout?.on('data', (d: Buffer) => o.log('[trueforge]', String(d).trimEnd()));
  child.stderr?.on('data', (d: Buffer) => o.log('[trueforge]', String(d).trimEnd()));
  child.on('exit', (code) => { exited = true; o.log(`trueforge: process exited (${code})`); });
  child.on('error', (e) => { exited = true; o.log('trueforge: spawn error', String(e)); });

  const stop = async () => {
    if (exited || !child.pid) return;
    await new Promise<void>((res) => treeKill(child.pid as number, 'SIGTERM', () => res()));
  };

  const deadline = Date.now() + (o.timeoutMs ?? 120000);
  const started = Date.now();
  while (Date.now() < deadline) {
    if (await o.ping()) {
      o.onState?.('running');
      return { startedByUs: true, state: 'running', stop };
    }
    if (exited) break;
    o.onState?.('starting', `Starting TrueForge... ${Math.round((Date.now() - started) / 1000)}s`);
    await sleep(o.pollMs ?? 1500);
  }
  await stop();
  const detail = exited ? 'TrueForge exited before becoming healthy (see the Contexo output channel).' : 'TrueForge did not become healthy in time.';
  o.onState?.('down', detail);
  return { startedByUs: false, state: 'down', detail, stop: noop };
}
