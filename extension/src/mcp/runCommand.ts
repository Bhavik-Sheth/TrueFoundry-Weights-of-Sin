/**
 * mcp/runCommand.ts - C3 allowlisted command runner (Slice 7).
 *
 * Exports:
 *  - runCommandIn(root, allowlist, argv, timeoutSec?): vscode-free core. argv[0] must be a bare program name
 *    whose basename (minus .exe) is in the allowlist; any later argument that is an absolute path or has a
 *    '..' segment is rejected (also after '--opt='). spawn(argv[0], rest, {cwd: root, shell:false, env: scopedEnv}).
 *    Timeout default 120 s, max 180 s, enforced with tree-kill. stdout/stderr capped (capOutput).
 *    Returns {exitCode, stdout, stderr, truncated, durationMs}; refusals use exitCode 126, timeouts 124.
 *  - runCommand(argv, timeoutSec?): same, with root and allowlist taken from the workspace and contexo config.
 *  - scopedEnv(root): PATH, SYSTEMROOT, HOME/USERPROFILE, TEMP/TMP, VIRTUAL_ENV, PYTHONPATH, LANG only;
 *    <root>/.venv/Scripts (Windows) or .venv/bin is prepended to PATH when present.
 *  - killAll(): tree-kill every tracked process (called on Stop).
 *
 * Rules: no shell; runs on the host in the real workspace (accepted limitation); needs TrueForge approval.
 * vscode is only required lazily so the core can be tested with Vitest.
 * Depends on: tree-kill, mcp/server (capOutput). Depended on by: mcp/tools, run/runManager.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import treeKill from 'tree-kill';
import { capOutput } from './server';

export interface RunResult { exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number }

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 180;
const MAX_CAPTURE = 200_000; // bytes kept in memory per stream before capping
const tracked = new Set<number>();

const refuse = (msg: string): RunResult => ({ exitCode: 126, stdout: '', stderr: msg, truncated: false, durationMs: 0 });

function progName(p: string): string {
  return path.basename(p).replace(/\.exe$/i, '').toLowerCase();
}

function escapesWorkspace(arg: string): boolean {
  const vals = [arg];
  const eq = arg.indexOf('=');
  if (arg.startsWith('-') && eq > 0) vals.push(arg.slice(eq + 1));
  return vals.some((v) =>
    path.win32.isAbsolute(v) || path.posix.isAbsolute(v) || /^[a-zA-Z]:/.test(v) || v.split(/[\/]+/).includes('..'));
}

export function scopedEnv(root: string): NodeJS.ProcessEnv {
  const src = process.env;
  const get = (k: string) => src[k] ?? src[Object.keys(src).find((x) => x.toUpperCase() === k) ?? ''];
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['SYSTEMROOT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'VIRTUAL_ENV', 'PYTHONPATH', 'LANG']) {
    const v = get(k);
    if (v !== undefined) env[k] = v;
  }
  const venvBin = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  let p = get('PATH') ?? '';
  if (fs.existsSync(venvBin)) {
    p = p ? `${venvBin}${path.delimiter}${p}` : venvBin;
    env.VIRTUAL_ENV = path.join(root, '.venv');
  }
  env.PATH = p;
  return env;
}

function resolveProgram(root: string, prog: string): string {
  if (process.platform !== 'win32') return prog;
  const name = progName(prog);
  if (['python', 'pytest', 'flask'].includes(name)) {
    const exe = path.join(root, '.venv', 'Scripts', `${name}.exe`);
    if (fs.existsSync(exe)) return exe;
  }
  return prog;
}

function finish(s: string, truncated: boolean): string {
  return truncated ? `${capOutput(s).text}\n...[truncated]...\n${s.slice(-2000)}` : s;
}

export async function runCommandIn(root: string, allowlist: string[], argv: string[], timeoutSec?: number): Promise<RunResult> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) return refuse('argv must be a non-empty string array');
  const prog = argv[0];
  if (/[\/]/.test(prog)) return refuse(`COMMAND_NOT_ALLOWED: use a bare program name, not a path (${prog})`);
  const allowed = allowlist.map((a) => progName(a));
  if (!allowed.includes(progName(prog))) return refuse(`COMMAND_NOT_ALLOWED: ${prog} is not in the allowlist (${allowlist.join(', ')})`);
  const bad = argv.slice(1).find(escapesWorkspace);
  if (bad !== undefined) return refuse(`PATH_OUTSIDE_WORKSPACE: argument "${bad}" must be a workspace-relative path`);

  const limit = Math.min(Math.max(Math.floor(timeoutSec ?? DEFAULT_TIMEOUT_SEC), 1), MAX_TIMEOUT_SEC) * 1000;
  const t0 = Date.now();
  return new Promise<RunResult>((resolve) => {
    let out = '';
    let err = '';
    let capped = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(resolveProgram(root, prog), argv.slice(1), { cwd: root, shell: false, env: scopedEnv(root), windowsHide: true });
    const pid = child.pid;
    if (pid) tracked.add(pid);
    const done = (exitCode: number, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid) tracked.delete(pid);
      resolve({
        exitCode,
        stdout: finish(out, out.length > 16000 || capped),
        stderr: finish(err + extraErr, err.length > 16000),
        truncated: capped || out.length > 16000 || err.length > 16000,
        durationMs: Date.now() - t0,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) treeKill(pid, 'SIGKILL', () => {});
    }, limit);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_CAPTURE) out += d.toString(); else capped = true; });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < MAX_CAPTURE) err += d.toString(); else capped = true; });
    child.on('error', (e) => done(127, `spawn failed: ${e.message}`));
    child.on('close', (code) => done(timedOut ? 124 : (code ?? -1), timedOut ? `\nTIMEOUT: killed after ${limit / 1000}s` : ''));
  });
}

export async function runCommand(argv: string[], timeoutSec?: number): Promise<RunResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof import('vscode');
  const folder = vs.workspace.workspaceFolders?.[0];
  if (!folder) return refuse('NO_WORKSPACE: open a folder first');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConfig } = require('../config') as typeof import('../config');
  return runCommandIn(folder.uri.fsPath, getConfig().commandAllowlist, argv, timeoutSec);
}

export function killAll(): void {
  for (const pid of [...tracked]) treeKill(pid, 'SIGKILL', () => {});
  tracked.clear();
}
