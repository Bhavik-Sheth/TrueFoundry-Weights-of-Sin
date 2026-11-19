/**
 * review/proposal.ts - C4 pure proposal logic (no vscode APIs, easily unit tested). REAL in S0.
 *
 * Exports:
 *  - sha256(text): hex hash helper (baseHash).
 *  - canonicalJson(v): JSON with recursively sorted keys and no whitespace.
 *  - proposalKey(args): sha256 of canonical JSON of propose_write args (links approval and MCP call).
 *  - applyEditExact(base, oldText, newText): replace oldText exactly once; errors
 *    OLD_TEXT_NOT_FOUND (0 matches) or AMBIGUOUS_MATCH (>1); empty oldText = create, requires base === ''.
 *    The file's EOL (CRLF vs LF) is preserved by normalising oldText/newText to it.
 *  - buildHunks(path, base, proposed, baseHash): jsdiff structuredPatch (3 context lines) -> Hunk[]
 *    with id = first 12 of sha(path + baseHash + hunk lines).
 *  - rebuildFromAccepted(base, hunks): apply only accepted hunks to base; REBUILD_FAILED if a hunk does not apply.
 *
 * Rules: never touches disk or the editor.
 * Depends on: node:crypto, diff (jsdiff), types. Depended on by: review/diffView, review/applyUndo,
 * dev/fixtures, test/proposal.test.ts.
 */
import { createHash } from 'node:crypto';
import { applyPatch, structuredPatch } from 'diff';
import type { Hunk, Sha } from '../types';

export function sha256(text: string): Sha {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function proposalKey(args: unknown): Sha {
  return sha256(canonicalJson(args));
}

function toEol(s: string, eol: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n/g, eol);
}

export function applyEditExact(base: string, oldText: string, newText: string): string {
  if (oldText === '') {
    if (base !== '') throw new Error('CREATE_REQUIRES_EMPTY_BASE: oldText is empty but the file already has content');
    return newText;
  }
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const o = toEol(oldText, eol);
  const n = toEol(newText, eol);
  const first = base.indexOf(o);
  if (first === -1) throw new Error('OLD_TEXT_NOT_FOUND: oldText does not occur in the file');
  if (base.indexOf(o, first + 1) !== -1) throw new Error('AMBIGUOUS_MATCH: oldText occurs more than once; include more context');
  return base.slice(0, first) + n + base.slice(first + o.length);
}

export function buildHunks(path: string, base: string, proposed: string, baseHash: Sha): Hunk[] {
  const patch = structuredPatch(path, path, base, proposed, '', '', { context: 3 });
  return patch.hunks.map((h) => ({
    id: sha256(path + baseHash + h.lines.join('\n')).slice(0, 12),
    path,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
    outsideSelection: false,
    decision: 'pending' as const,
  }));
}

export function rebuildFromAccepted(base: string, hunks: Hunk[]): string {
  const accepted = hunks.filter((h) => h.decision === 'accepted');
  if (accepted.length === 0) return base;
  const path = accepted[0].path;
  const result = applyPatch(base, {
    oldFileName: path,
    newFileName: path,
    oldHeader: '',
    newHeader: '',
    hunks: accepted.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })),
  });
  if (result === false) throw new Error('REBUILD_FAILED: accepted hunks do not apply to the base text');
  return result;
}

// ---- Pure decision bookkeeping (used by ReviewEngine; no vscode) ----

export type Decision = 'accepted' | 'rejected';

/** Sets one hunk's decision in place. Returns false if the hunk id is unknown. */
export function setHunkDecision(hunks: Hunk[], hunkId: string, d: Decision): boolean {
  const h = hunks.find((x) => x.id === hunkId);
  if (!h) return false;
  h.decision = d;
  return true;
}

/** Sets every hunk's decision in place. */
export function setAllDecisions(hunks: Hunk[], d: Decision): void {
  for (const h of hunks) h.decision = d;
}

export function acceptedCount(hunks: Hunk[]): number {
  return hunks.filter((h) => h.decision === 'accepted').length;
}

/** applied = accepted hunk ids; rejected = every other hunk id (pending counts as rejected). */
export function computeResult(hunks: Hunk[]): { applied: string[]; rejected: string[] } {
  return {
    applied: hunks.filter((h) => h.decision === 'accepted').map((h) => h.id),
    rejected: hunks.filter((h) => h.decision !== 'accepted').map((h) => h.id),
  };
}

/** Wraps a resolver so it runs at most once. */
export function once<A extends unknown[]>(fn: ((...a: A) => void) | undefined): (...a: A) => void {
  let done = false;
  return (...a: A) => {
    if (done) return;
    done = true;
    fn?.(...a);
  };
}

/** Accepted hunks of one file rebuilt onto its base text (path filter + rebuildFromAccepted). */
export function rebuildFile(base: string, path: string, hunks: Hunk[]): string {
  return rebuildFromAccepted(base, hunks.filter((h) => h.path === path));
}
