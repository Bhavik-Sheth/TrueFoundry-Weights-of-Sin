/**
 * context/search.ts - C3 lexical retrieval primitives.
 *
 * Exports:
 *  - tokenize(text): identifier tokenizer with snake_case/camelCase splitting and stopword removal (REAL).
 *  - class Bm25 / bm25Rank(query, docs): small BM25 over symbol entries and doc sections (REAL, generic over {id,text}).
 *  - symbolNameMatch(terms, symbols): ranked symbol-name matches (REAL).
 *  - ripgrepSearch(term, opts): S0 STUB returning []; Slice 2 runs rg --json with VS Code's bundled rg.
 *
 * Rules: pure (no vscode import, so stubs log via console.debug, not log()).
 * Depends on: types. Depended on by: context/assembler, mcp/tools.
 */
import type { SymbolEntry } from '../types';

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'it', 'its', 'this', 'that',
  'as', 'by', 'be', 'at', 'from', 'add', 'new', 'make', 'use', 'get', 'set', 'should', 'would', 'can', 'will',
  'please', 'all', 'any', 'into', 'so', 'if', 'not', 'but', 'than', 'then', 'also', 'when', 'what', 'how',
]);

/** Lowercased terms; snake_case and camelCase are split; the unsplit identifier is kept too. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const ids = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const id of ids) {
    const parts = id
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    const whole = id.toLowerCase();
    const cands = parts.length > 1 ? [whole, ...parts] : parts;
    for (const c of cands) if (c.length > 1 && !STOPWORDS.has(c)) out.push(c);
  }
  return out;
}

export interface Bm25Doc { id: string; text: string }

export class Bm25 {
  private tf: Array<Map<string, number>> = [];
  private len: number[] = [];
  private df = new Map<string, number>();
  private avg = 0;
  constructor(private docs: Bm25Doc[], private k1 = 1.5, private b = 0.75) {
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(d.text);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      total += toks.length;
    }
    this.avg = docs.length ? total / docs.length : 0;
  }
  /** Returns docs with score > 0, best first. */
  rank(query: string): Array<{ id: string; score: number }> {
    const q = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const res: Array<{ id: string; score: number }> = [];
    this.docs.forEach((d, i) => {
      let s = 0;
      for (const t of q) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / (this.avg || 1)));
      }
      if (s > 0) res.push({ id: d.id, score: s });
    });
    return res.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}

export function bm25Rank(query: string, docs: Bm25Doc[]): Array<{ id: string; score: number }> {
  return new Bm25(docs).rank(query);
}

/** Exact name match scores 2, qualified-name suffix 1.5, substring 1; best first. */
export function symbolNameMatch(
  terms: string[],
  symbols: SymbolEntry[],
): Array<{ symbol: SymbolEntry; term: string; score: number }> {
  const out: Array<{ symbol: SymbolEntry; term: string; score: number }> = [];
  for (const s of symbols) {
    const name = s.name.toLowerCase();
    let best: { term: string; score: number } | undefined;
    for (const t of terms) {
      const tl = t.toLowerCase();
      const score = name === tl ? 2 : s.qualifiedName.toLowerCase().endsWith('.' + tl) ? 1.5 : name.includes(tl) ? 1 : 0;
      if (score > 0 && (!best || score > best.score)) best = { term: t, score };
    }
    if (best) out.push({ symbol: s, ...best });
  }
  return out.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id));
}

export async function ripgrepSearch(
  term: string,
  o?: { glob?: string; max?: number },
): Promise<Array<{ path: string; line: number; preview: string }>> {
  console.debug('[stub] ripgrepSearch', term, o);
  return [];
}
