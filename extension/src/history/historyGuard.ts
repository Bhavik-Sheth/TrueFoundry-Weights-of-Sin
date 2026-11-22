/**
 * historyGuard.ts - pure helpers for the Chesterton's Fence history check.
 *
 * Exports: GUARD_LINE, needsHistoryCheck, parseBlamePorcelain, detectConcern, WhyExists, explainRange
 * (explainRange shells out to git via execFile; cached by path + HEAD sha).
 * Notes: the pure helpers do no git or vscode access; callers feed in diff hunks and `git blame --porcelain` /
 * commit-message text. Hunk lines carry a '+', '-' or ' ' prefix.
 * Must not import 'vscode'.
 * Depends on: types.ts (type only).
 * Depended on by: history git access and staging gate (later tasks).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Hunk, ProposeArgs } from '../types';
import type { IndexApi } from '../context/indexer';
import { workspaceGitEnv } from '../shell/workspaceGitEnv';

/** A removed line that starts like a guard/error-handling construct, or carries a warning marker. */
export const GUARD_LINE =
  /^-\s*(?:if |elif |try:|except|raise |assert |with\s+[\w.]*lock)|^-.*(?:\b(?:TODO|NOTE|HACK|XXX)\b|do not|don't remove|workaround)/i;

export function needsHistoryCheck(hunk: Hunk, minLines = 3): boolean {
  const removed = hunk.lines.filter((l) => l.startsWith('-'));
  return removed.length >= minLines || removed.some((l) => GUARD_LINE.test(l));
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

export function parseBlamePorcelain(out: string): Array<{ sha: string; lines: number[] }> {
  const bySha = new Map<string, number[]>();
  for (const raw of out.split('\n')) {
    const m = BLAME_HEADER.exec(raw.replace(/\r$/, ''));
    if (!m || /^0+$/.test(m[1])) continue;
    const list = bySha.get(m[1]) ?? [];
    list.push(Number(m[2]));
    bySha.set(m[1], list);
  }
  return [...bySha].map(([sha, lines]) => ({ sha, lines }));
}

const SPECIFIC_CONCERN =
  /\b(?:fix|bug|regression|race|deadlock|security|CVE-|vuln|workaround|compat|revert|hotfix|leak|crash|edge case)/gi;
const GENERIC_CONCERN = new Set(['fix', 'bug']);

export function detectConcern(subject: string, body: string): { concern: string | null; issues: string[]; prs: number[] } {
  const text = `${subject}\n${body}`;
  // "fix"/"bug" are in nearly every commit subject, so a more specific keyword wins over them.
  let concern: string | null = null;
  let generic: string | null = null;
  for (const m of text.matchAll(SPECIFIC_CONCERN)) {
    const kw = m[0].toLowerCase() === 'cve-' ? 'CVE-' : m[0].toLowerCase();
    if (GENERIC_CONCERN.has(kw)) generic ??= kw;
    else { concern = kw; break; }
  }
  concern ??= generic;

  const prs: number[] = [];
  const pr = /\(#(\d+)\)\s*$/.exec(subject.trim());
  if (pr) prs.push(Number(pr[1]));

  const issues: string[] = [];
  for (const m of text.matchAll(/(?:#|GH-)(\d+)/gi)) {
    const n = Number(m[1]);
    const tag = `#${n}`;
    if (prs.includes(n) && m.index !== undefined && text.slice(m.index - 1, m.index) === '(') continue;
    if (!issues.includes(tag)) issues.push(tag);
  }
  return { concern, issues, prs };
}

export interface WhyExists {
  commits: Array<{ sha: string; author: string; date: string; subject: string; bodyExcerpt: string; lines: [number, number] }>;
  issues: string[];
  prs: number[];
  tests: string[];
  concern: string | null;
  note?: 'shallow' | 'uncommitted' | 'no-git';
}

const execFileAsync = promisify(execFile);
const cache = new Map<string, WhyExists>();

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, env: workspaceGitEnv(), timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/** Why do lines startLine..endLine of `path` exist? Blame commits, messages, linked issues/PRs and related tests. */
export async function explainRange(root: string, path: string, startLine: number, endLine: number, index?: IndexApi): Promise<WhyExists> {
  const empty = (note?: WhyExists['note']): WhyExists => ({ commits: [], issues: [], prs: [], tests: [], concern: null, ...(note ? { note } : {}) });
  let head: string;
  try {
    head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return empty('no-git');
  }
  const key = `${path}:${head}:${startLine}-${endLine}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result: WhyExists;
  try {
    if ((await git(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') return empty('shallow');
    try {
      await git(root, ['cat-file', '-e', `HEAD:${path}`]);
    } catch {
      return empty('uncommitted');
    }
    const blame = parseBlamePorcelain(await git(root, ['blame', '--porcelain', '-w', '-M', '-C', '-L', `${startLine},${endLine}`, 'HEAD', '--', path]));
    result = empty();
    for (const b of blame) {
      const [sha, author, date, subject, ...rest] = (await git(root, ['show', '-s', '--format=%H%x00%an%x00%aI%x00%s%x00%b', b.sha])).replace(/\n$/, '').split('\0');
      const body = rest.join('\0').trim();
      result.commits.push({ sha, author, date, subject, bodyExcerpt: body.slice(0, 300), lines: [Math.min(...b.lines), Math.max(...b.lines)] });
      const d = detectConcern(subject, body);
      result.concern ??= d.concern;
      for (const i of d.issues) if (!result.issues.includes(i)) result.issues.push(i);
      for (const p of d.prs) if (!result.prs.includes(p)) result.prs.push(p);
    }
  } catch {
    return empty('no-git');
  }

  const enclosing = index?.enclosing(path, startLine);
  if (index && enclosing) {
    result.tests = index.symbols().filter((s) => s.kind === 'test' && s.calls.includes(enclosing.name)).map((s) => s.id);
  }
  cache.set(key, result);
  return result;
}

/** Shrinks a WhyExists so its JSON is <= max chars: drops oldest commits first, then trims issues/prs/tests. */
export function capWhyExists(w: WhyExists, max = 4000): WhyExists {
  const out: WhyExists = { ...w, commits: [...w.commits].sort((a, b) => b.date.localeCompare(a.date)), issues: [...w.issues], prs: [...w.prs], tests: [...w.tests] };
  const fits = () => JSON.stringify(out).length <= max;
  while (!fits() && out.commits.length > 0) out.commits.pop();
  for (const key of ['issues', 'prs', 'tests'] as const) {
    while (!fits() && out[key].length > 0) out[key].pop();
  }
  return out;
}

type HistoryConcern = NonNullable<Hunk['historyConcern']>;

/**
 * Chesterton's Fence gate: denies once per (runId, path, sha) when a hunk removes code whose history records a concern
 * and the agent has not acknowledged that commit; otherwise returns the per-hunk flags for review.
 */
export function historyGate(input: {
  runId: string;
  hunks: Hunk[];
  explains: Map<string, WhyExists>;
  acknowledged: ProposeArgs['acknowledgedHistory'];
  denied: Set<string>;
}): { deny?: string; flags: Map<string, HistoryConcern> } {
  const flags = new Map<string, HistoryConcern>();
  const acks = input.acknowledged ?? [];
  const found: Array<{ hunk: Hunk; flag: HistoryConcern; ack?: string }> = [];
  for (const hunk of input.hunks) {
    const w = input.explains.get(hunk.id);
    if (!w) continue;
    for (const c of w.commits) {
      const d = detectConcern(c.subject, c.bodyExcerpt);
      if (!d.concern) continue;
      const ack = acks.find((a) => a.commit.length >= 7 && c.sha.startsWith(a.commit));
      found.push({ hunk, flag: { sha: c.sha, subject: c.subject, concern: d.concern, issues: d.issues, ...(ack ? { acknowledgement: ack.reason } : {}) }, ack: ack?.reason });
      break;
    }
  }
  for (const { hunk, flag, ack } of found) {
    const key = `${input.runId}:${hunk.path}:${flag.sha}`;
    if (ack === undefined && !input.denied.has(key)) {
      input.denied.add(key);
      const start = hunk.oldStart;
      const end = hunk.oldStart + hunk.oldLines - 1;
      const issues = flag.issues.length ? ` (${flag.issues.join(', ')})` : '';
      return {
        deny: `HISTORY_CONCERN ${hunk.path}:${start}-${end} commit ${flag.sha.slice(0, 7)} "${flag.subject}"${issues}. Explain how your change preserves this, then re-propose with acknowledgedHistory.`,
        flags,
      };
    }
  }
  for (const { hunk, flag } of found) flags.set(hunk.id, flag);
  return { flags };
}

/** True when a hunk carries history that the reviewer has not read yet. */
export function blockedByHistory(h: Hunk): boolean {
  return !!h.historyConcern && !h.historyConcern.read;
}

/** Splits hunks for "accept all": hunks with unread history are held back for individual review. */
export function partitionAcceptAll(hunks: Hunk[]): { accept: Hunk[]; held: Hunk[] } {
  return { accept: hunks.filter((h) => !blockedByHistory(h)), held: hunks.filter(blockedByHistory) };
}
