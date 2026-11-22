/**
 * context/search.ts - C3 lexical retrieval primitives.
 *
 * Exports:
 *  - tokenize(text): identifier tokenizer with snake_case/camelCase splitting and stopword removal.
 *  - class Bm25 / bm25Rank(query, docs): small BM25 (k1=1.2, b=0.75) over {id,text} docs; query is text or terms[].
 *  - symbolNameMatch(terms, symbols): ranked symbol-name matches (exact 3, prefix 2, contains 1).
 *  - resolveRgPath(appRoot?): VS Code's bundled rg (node_modules[.asar.unpacked]/@vscode/ripgrep/bin or ripgrep-universal/bin/<platform>-<arch>), else `rg` on PATH.
 *  - ripgrepSearch(term, opts): runs rg --json -n -i -F --max-count 50 and returns {path, line, preview}.
 *
 * Rules: no top-level vscode import (vscode is required lazily, only when cwd/rgPath are not passed in opts),
 * so this module is importable under Vitest.
 * Depends on: types, node:child_process. Depended on by: context/indexer, context/assembler, mcp/tools.
 */
import { workspaceRoot } from '../shell/workspaceRoot';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  private postings = new Map<string, Array<{ document: number; frequency: number }>>();
  private normalization: number[];
  private ids: string[];

  constructor(docs: Bm25Doc[], private k1 = 1.2, private b = 0.75) {
    this.ids = docs.map(doc => doc.id);
    const lengths = docs.map(({ text }, document) => {
      const tokens = tokenize(text);
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const [token, frequency] of frequencies) {
        const list = this.postings.get(token);
        if (list) list.push({ document, frequency });
        else this.postings.set(token, [{ document, frequency }]);
      }
      return tokens.length;
    });
    const average = lengths.reduce((sum, length) => sum + length, 0) / (docs.length || 1);
    this.normalization = lengths.map(length => this.k1 * (1 - this.b + this.b * length / (average || 1)));
  }

  /** Returns documents matching at least one term, in deterministic BM25 rank order. */
  rank(query: string | string[], k?: number): Array<{ id: string; score: number }> {
    const terms = new Set(tokenize(Array.isArray(query) ? query.join(' ') : query));
    const scores = new Map<number, number>();
    for (const term of terms) {
      const matches = this.postings.get(term);
      if (!matches) continue;
      const idf = Math.log(1 + (this.ids.length - matches.length + 0.5) / (matches.length + 0.5));
      for (const { document, frequency } of matches) {
        const contribution = (idf * frequency * (this.k1 + 1)) / (frequency + this.normalization[document]);
        scores.set(document, (scores.get(document) ?? 0) + contribution);
      }
    }
    const ranked = [...scores].map(([document, score]) => ({ id: this.ids[document], score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return k ? ranked.slice(0, k) : ranked;
  }
}

export function bm25Rank(query: string | string[], docs: Bm25Doc[], k?: number): Array<{ id: string; score: number }> {
  return new Bm25(docs).rank(query, k);
}

/** Exact name match scores 3, prefix 2, substring 1; best first. */
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
      if (!tl) continue;
      const score = name === tl ? 3 : name.startsWith(tl) ? 2 : name.includes(tl) ? 1 : 0;
      if (score > 0 && (!best || score > best.score)) best = { term: t, score };
    }
    if (best) out.push({ symbol: s, ...best });
  }
  return out.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id));
}

/** Pure: VS Code's bundled ripgrep under `appRoot`, else plain `rg` (PATH). */
export function resolveRgPath(appRoot?: string): string {
  if (appRoot) {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    for (const mod of ['node_modules', 'node_modules.asar.unpacked']) {
      for (const bin of [path.join('ripgrep', 'bin'), path.join('ripgrep-universal', 'bin', `${process.platform}-${process.arch}`)]) {
        const p = path.join(appRoot, mod, '@vscode', bin, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return 'rg';
}

/** Lazily reads appRoot and the first workspace folder from vscode (not importable under Vitest). */
export function vscodeRgContext(): { rgPath: string; cwd?: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vs = require('vscode') as typeof import('vscode');
  return { rgPath: resolveRgPath(vs.env.appRoot), cwd: workspaceRoot()?.uri.fsPath };
}

export interface RgOptions { glob?: string; max?: number; cwd?: string; rgPath?: string }

export async function ripgrepSearch(
  term: string,
  o: RgOptions = {},
): Promise<Array<{ path: string; line: number; preview: string }>> {
  const ctx = o.cwd && o.rgPath ? { rgPath: o.rgPath, cwd: o.cwd } : vscodeRgContext();
  const cwd = o.cwd ?? ctx.cwd;
  const rgPath = o.rgPath ?? ctx.rgPath;
  if (!cwd) return [];
  const max = o.max ?? 50;
  const args = ['--json', '-n', '-i', '-F', '--max-count', '50'];
  if (o.glob) args.push('-g', o.glob);
  args.push('-e', term, '.');
  return new Promise((resolve) => {
    const hits: Array<{ path: string; line: number; preview: string }> = [];
    let buf = '';
    let done = false;
    const child = spawn(rgPath, args, { cwd, windowsHide: true });
    const finish = () => {
      if (done) return;
      done = true;
      resolve(hits);
    };
    const handle = (line: string) => {
      if (!line || hits.length >= max) return;
      try {
        const m = JSON.parse(line);
        if (m.type !== 'match') return;
        const p: string | undefined = m.data?.path?.text;
        if (!p) return;
        hits.push({
          path: p.replace(/\\/g, '/').replace(/^\.\//, ''),
          line: m.data.line_number as number,
          preview: String(m.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 200),
        });
      } catch { /* ignore malformed line */ }
    };
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(handle);
      if (hits.length >= max) { child.kill(); finish(); }
    });
    child.on('error', finish);
    child.on('close', () => { handle(buf); finish(); });
  });
}
