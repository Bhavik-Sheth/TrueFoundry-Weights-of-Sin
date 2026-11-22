/**
 * mentions.ts - ranking for @ mention completion in the chat box.
 *
 * Exports:
 *  - MentionItem (re-exported from ../types)
 *  - rankMentions(q, symbols, paths, limit = 20): scores symbols and workspace paths against q (case-insensitive,
 *    best rule wins) and returns the top items. Empty q yields []; doc symbols are excluded.
 *
 * Depends on: types.ts (pure; no vscode). Depended on by: extension.ts.
 */
import type { MentionItem, SymbolEntry } from '../types';

export type { MentionItem };

const isSubsequence = (q: string, s: string): boolean => {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return false;
};

export function rankMentions(q: string, symbols: SymbolEntry[], paths: string[], limit = 20): MentionItem[] {
  const needle = q.toLowerCase();
  if (!needle) return [];
  const scored: Array<{ score: number; item: MentionItem }> = [];
  for (const s of symbols) {
    if (s.kind === 'doc') continue;
    const name = s.name.toLowerCase();
    const qn = s.qualifiedName.toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (qn.includes(needle)) score = 50;
    else if (isSubsequence(needle, name) || isSubsequence(needle, qn)) score = 10;
    if (score) scored.push({ score, item: { kind: 'symbol', insert: '@' + s.qualifiedName, label: s.qualifiedName, detail: `${s.kind} · ${s.path}:${s.startLine}` } });
  }
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = 0;
    if (base.startsWith(needle)) score = 60;
    else if (lower.includes(needle)) score = 30;
    else if (isSubsequence(needle, lower)) score = 10;
    if (score) scored.push({ score, item: { kind: 'file', insert: '@' + p, label: p.slice(p.lastIndexOf('/') + 1), detail: p } });
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length);
  return scored.slice(0, limit).map(x => x.item);
}
