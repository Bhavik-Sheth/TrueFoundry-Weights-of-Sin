/**
 * historyGuard.ts - pure helpers for the Chesterton's Fence history check.
 *
 * Exports: GUARD_LINE, needsHistoryCheck, parseBlamePorcelain, detectConcern.
 * Notes: no git or vscode access here; callers feed in diff hunks and `git blame --porcelain` /
 * commit-message text. Hunk lines carry a '+', '-' or ' ' prefix.
 * Must not import 'vscode'.
 * Depends on: types.ts (type only).
 * Depended on by: history git access and staging gate (later tasks).
 */
import type { Hunk } from '../types';

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
  /fix|bug|regression|race|deadlock|security|CVE-|vuln|workaround|compat|revert|hotfix|leak|crash|edge case/gi;
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
