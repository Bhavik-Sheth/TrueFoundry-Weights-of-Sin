/**
 * context/assembler.ts - C3 budgeted hybrid retrieval (assemble_context). The core novel file (criterion B1).
 *
 * STRATEGY (for the write-up)
 *  1. Anchors: @path mentions (suffix match) and @name mentions (index.byName) plus the editor selection are
 *     MANDATORY. Terms come from the request: quoted strings, UPPERCASE constants, identifiers, "flask X" CLI phrases,
 *     plain words minus stopwords, and a small synonym table (command -> click, add_command, cli; docs -> rst, ...).
 *  2. Candidate lists, each ranked separately and keeping reason {kind, term, rank}: BM25 over code symbols, BM25 over
 *     doc sections, symbol-name match (exact > prefix), ripgrep hits mapped to their enclosing symbol. Terms that occur
 *     in more than 30% of all symbols (e.g. the project name) are dropped as non-discriminating.
 *  3. One-hop expansion of the top 10 fused implementation symbols, one list per relation: calls, called-by, registers
 *     (click/CLI decorators, add_command(...) call sites, decorator-siblings in the file), tests (tests that
 *     reference the name, tests in test_<module>.py), documents (doc sections naming the symbol or its CLI name).
 *  4. Reciprocal Rank Fusion (k = 60): score += 1/(k + rank) for each list a candidate appears in; reasons are merged.
 *  5. Packing under the token budget: mandatory first; reserve the best test and best docs candidate; then greedy by
 *     score/tokens (tokens floored at 400 so tiny snippets do not crowd out real code); overlapping ranges are omitted
 *     as 'duplicate'; after 3 excerpts from one file the score is halved; what does not fit is 'over-budget'; ranks
 *     beyond the top 40 are 'lower-rank'. A symbol bigger than 30% of the budget is trimmed to signature + docstring
 *     + term-matching lines. Every omission is listed with its reason and token count.
 *  6. Graph: request -> term -> file -> symbol with labelled edges; heuristic edges are flagged inferred.
 *
 * Rules: pure (no vscode import; ripgrep is injectable and the default degrades to "no hits" outside VS Code).
 * Depends on: context/search, context/indexer (type), context/tokens, types. Depended on by: mcp/tools.
 */
import type { ContextPacket, Excerpt, Reason, Selection, SymbolEntry } from '../types';
import type { IndexApi } from './indexer';
import { Bm25, STOPWORDS, ripgrepSearch, symbolNameMatch, tokenize, vscodeRgContext } from './search';
import { count } from './tokens';

export interface Candidate {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  category: 'impl' | 'test' | 'docs';
  text: string;
  score: number;
  reasons: Reason[];
}

export interface RankedList {
  name: string;
  items: Candidate[];
  /** RRF contribution multiplier (default 1); expansion lists use < 1 because they are inferred, not searched. */
  weight?: number;
}

export type RgFn = (term: string) => Promise<Array<{ path: string; line: number; preview: string }>>;

export interface AssembleInput {
  request: string;
  mentions?: string[];
  budget?: number;
  selection?: Selection;
  runId: string;
  /** Ripgrep provider; default uses VS Code's bundled rg (no hits when vscode is unavailable). */
  rg?: RgFn;
}

const DEFAULT_BUDGET = 8000;
const TOP_N = 40;
const MAX_OMITTED_LOWER = 15;
const LIST_CAP = 30;
const MIN_REL_SCORE = 0.5;

// ------------------------------------------------------------------ helpers

function categoryOf(s: { path: string; kind?: string }): Candidate['category'] {
  if (s.kind === 'doc' || /\.(rst|md)$/.test(s.path)) return 'docs';
  if (/(^|\/)tests?\//.test(s.path) || /(^|\/)test_[^/]*$/.test(s.path)) return 'test';
  return 'impl';
}

function fromSymbol(s: SymbolEntry, reasons: Reason[], score = 0): Candidate {
  return { id: s.id, path: s.path, startLine: s.startLine, endLine: s.endLine, category: categoryOf(s), text: s.text, score, reasons };
}

const isCode = (s: SymbolEntry) => s.kind !== 'doc';
const sameReason = (a: Reason, b: Reason) => JSON.stringify(a) === JSON.stringify(b);

const EXTRA_STOP = new Set([
  'prints', 'print', 'loaded', 'load', 'application', 'app', 'appear', 'covered', 'documented', 'alongside', 'other',
  'must', 'key', 'keys', 'values', 'value', 'any', 'containing', 'contain', 'help', 'built', 'builtin', 'which', 'each',
  'every', 'there', 'their', 'have', 'has', 'was', 'were', 'does', 'did', 'about', 'like', 'just', 'need', 'want',
  'implement', 'create', 'write', 'fix', 'update', 'change', 'let', 'should', 'could', 'only', 'without', 'using',
  'ensure', 'returns', 'return', 'show', 'shows', 'we', 'you', 'our', 'your', 'my', 'me', 'one', 'two',
]);
// Words that carry intent in a request even though they are generic; kept despite EXTRA_STOP.
const KEEP = new Set(['help']);

const SYNONYMS: Record<string, string[]> = {
  command: ['click', 'add_command', 'cli'],
  commands: ['click', 'add_command', 'cli'],
  config: ['config'],
  configuration: ['config'],
  test: ['test_'],
  tests: ['test_'],
  docs: ['rst'],
  documented: ['rst'],
  documentation: ['rst'],
};

const termTokens = (t: string) => tokenize(t);

// ------------------------------------------------------------------ 1. anchors

interface RawTerm { term: string; weight: number }

/** Ordered, de-duplicated search terms: specific ones (identifiers, constants, quoted, CLI phrases) first. */
function extractTerms(request: string): string[] {
  const raw: RawTerm[] = [];
  const add = (term: string, weight: number) => {
    const t = term.trim();
    if (t.length >= 2) raw.push({ term: t, weight });
  };
  for (const m of request.matchAll(/(["'`])((?:\\.|(?!\1).){2,40}?)\1/g)) {
    const inner = m[2].replace(/\\(.)/g, '$1');
    if (/[A-Za-z0-9]/.test(inner)) add(inner.toLowerCase(), 4);
  }
  for (const m of request.matchAll(/\bflask\s+([a-z][\w-]*)/gi)) add(m[1].toLowerCase(), 4);
  for (const m of request.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) add(m[0].toLowerCase(), 3);
  for (const m of request.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    const lower = w.toLowerCase();
    const specific = /_/.test(w) || /[a-z][A-Z]/.test(w);
    if (specific) { add(lower, 3); continue; }
    if (/^[A-Z0-9_]+$/.test(w)) continue; // constants handled above
    if ((STOPWORDS.has(lower) || EXTRA_STOP.has(lower)) && !KEEP.has(lower)) continue;
    add(lower, 1);
    for (const syn of SYNONYMS[lower] ?? []) add(syn, 0.5);
  }
  const best = new Map<string, number>();
  const order: string[] = [];
  for (const r of raw) {
    if (!best.has(r.term)) order.push(r.term);
    best.set(r.term, Math.max(best.get(r.term) ?? 0, r.weight));
  }
  return order
    .map((t, i) => ({ t, w: best.get(t) ?? 0, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.t)
    .slice(0, 30);
}

function looksLikePath(m: string): boolean {
  return m.includes('/') || /\.[A-Za-z]{1,5}$/.test(m);
}

function topLevel(syms: SymbolEntry[]): SymbolEntry[] {
  return syms.filter((s) => !syms.some((o) => o !== s && o.startLine <= s.startLine && o.endLine >= s.endLine && (o.endLine - o.startLine > s.endLine - s.startLine)));
}

function mentionCandidates(mention: string, terms: string[], index: IndexApi, budget: number): Candidate[] {
  const token = mention.replace(/^@/, '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!token) return [];
  const reason: Reason = { kind: 'mention', token: `@${token}` };
  if (looksLikePath(token)) {
    const syms = index.symbols();
    const paths = [...new Set(syms.map((s) => s.path))].filter((p) => p === token || p.endsWith(`/${token}`));
    const out: Candidate[] = [];
    for (const p of paths) {
      const inFile = index.inFile(p).slice().sort((a, b) => a.startLine - b.startLine);
      const tops = topLevel(inFile);
      const total = tops.reduce((n, s) => n + count(s.text), 0);
      if (total <= budget * 0.3) {
        for (const s of tops) out.push(fromSymbol(s, [reason], 1));
      } else {
        const tk = new Set(terms.flatMap(termTokens));
        const scored = tops.map((s) => ({ s, hit: tokenize(`${s.qualifiedName} ${s.text}`).filter((t) => tk.has(t)).length }));
        scored.sort((a, b) => b.hit - a.hit || a.s.startLine - b.s.startLine);
        for (const { s } of scored.slice(0, 3)) out.push(fromSymbol(s, [reason], 1));
      }
    }
    if (out.length) return out;
  }
  const name = token.replace(/\(\)$/, '');
  let matches = index.byName(name);
  const code = matches.filter(isCode);
  if (code.length) matches = code;
  const weight = matches.length > 1 ? 0.5 : 1;
  return matches.map((s) => fromSymbol(s, [reason], weight));
}

export function extractAnchors(
  request: string,
  mentions: string[] = [],
  sel?: Selection,
  index?: IndexApi,
  budget: number = DEFAULT_BUDGET,
): { terms: string[]; mandatory: Candidate[] } {
  const terms = extractTerms(request);
  const mandatory: Candidate[] = [];
  if (sel) {
    const reason: Reason = { kind: 'selection' };
    const enc = index?.enclosing(sel.path, sel.startLine + 1);
    mandatory.push(enc
      ? fromSymbol(enc, [reason], 1)
      : { id: `${sel.path}#sel@${sel.startLine + 1}`, path: sel.path, startLine: sel.startLine + 1, endLine: sel.endLine + 1, category: categoryOf({ path: sel.path }), text: sel.text, score: 1, reasons: [reason] });
  }
  if (index) for (const m of mentions) mandatory.push(...mentionCandidates(m, terms, index, budget));
  const seen = new Map<string, Candidate>();
  for (const c of mandatory) {
    const cur = seen.get(c.id);
    if (cur) cur.reasons.push(...c.reasons); else seen.set(c.id, c);
  }
  return { terms, mandatory: [...seen.values()] };
}

// ------------------------------------------------------------------ 2. candidate lists

function defaultRg(): RgFn {
  return async (term) => {
    try {
      const ctx = vscodeRgContext();
      return await ripgrepSearch(term, { cwd: ctx.cwd, rgPath: ctx.rgPath, max: 40 });
    } catch {
      return [];
    }
  };
}

function firstMatchingTerm(text: string, terms: string[]): string | undefined {
  const toks = new Set(tokenize(text));
  return terms.find((t) => termTokens(t).some((x) => toks.has(x)));
}

export async function candidateLists(terms: string[], index: IndexApi, rg?: RgFn): Promise<RankedList[]> {
  const all = index.symbols();
  const code = all.filter(isCode);
  const docs = all.filter((s) => s.kind === 'doc');
  const lists: RankedList[] = [];
  if (!terms.length) return lists;

  // Drop non-discriminating terms (present in > 30% of code symbols).
  const sets = code.map((s) => new Set(tokenize(`${s.path} ${s.qualifiedName} ${s.text}`)));
  const dfOf = (t: string) => {
    const toks = termTokens(t);
    return toks.length && code.length ? sets.filter((st) => toks.some((x) => st.has(x))).length / code.length : 0;
  };
  const useful = terms.filter((t) => termTokens(t).length > 0 && dfOf(t) <= 0.3);
  const q = useful.length ? useful : terms;

  const byId = new Map(all.map((s) => [s.id, s]));
  const bm = (name: string, syms: SymbolEntry[]): RankedList => {
    const docsIn = syms.map((s) => ({
      id: s.id,
      text: `${s.qualifiedName} ${s.qualifiedName} ${s.path} ${s.decorators.join(' ')} ${s.text}`,
    }));
    const ranked = new Bm25(docsIn).rank(q, LIST_CAP);
    return {
      name,
      items: ranked.map((r, i) => {
        const s = byId.get(r.id)!;
        const term = firstMatchingTerm(`${s.qualifiedName} ${s.text}`, q) ?? q[0];
        return fromSymbol(s, [{ kind: 'lexical', term, rank: i + 1 }]);
      }),
    };
  };
  lists.push(bm('bm25-symbols', code));
  if (docs.length) lists.push(bm('bm25-docs', docs));

  const names = symbolNameMatch(q.flatMap((t) => [t, ...termTokens(t)]), code)
    .filter((m) => m.score === 3 || (m.score === 2 && m.term.length >= 5))
    .slice(0, LIST_CAP);
  lists.push({
    name: 'symbol-name',
    items: names.map((m, i) => fromSymbol(m.symbol, [{ kind: 'symbol-name', term: m.term, rank: i + 1 }])),
  });

  // Ripgrep: only the most specific terms; hits mapped to their enclosing symbol.
  const run = rg ?? defaultRg();
  const rgTerms = q.filter((t) => t.length >= 3 && dfOf(t) <= 0.08).slice(0, 4); // only distinctive terms are worth a grep
  const hitsByTerm = await Promise.all(rgTerms.map(async (t) => ({ t, hits: await run(t).catch(() => []) })));
  const agg = new Map<string, { sym: SymbolEntry; terms: Set<string>; n: number }>();
  for (const { t, hits } of hitsByTerm) {
    for (const h of hits) {
      const sym = index.enclosing(h.path, h.line);
      if (!sym) continue;
      const cur = agg.get(sym.id) ?? { sym, terms: new Set<string>(), n: 0 };
      cur.terms.add(t);
      cur.n++;
      agg.set(sym.id, cur);
    }
  }
  const rgRanked = [...agg.values()].sort((a, b) => b.terms.size - a.terms.size || b.n - a.n || a.sym.id.localeCompare(b.sym.id)).slice(0, LIST_CAP);
  if (rgRanked.length) {
    lists.push({
      name: 'ripgrep',
      items: rgRanked.map((x, i) => fromSymbol(x.sym, [{ kind: 'lexical', term: [...x.terms][0], rank: i + 1 }])),
    });
  }
  return lists;
}

// ------------------------------------------------------------------ 3. one-hop expansion

const REG_DECORATOR = /\.command\(|click\.command|add_command|app\.cli/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (s: string) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(s)}($|[^A-Za-z0-9_])`);

/** CLI names a symbol answers to: its click.command("x") argument and its name minus a _command suffix. */
function cliNames(s: SymbolEntry): string[] {
  const out = new Set<string>();
  for (const d of s.decorators) {
    const m = /command\(\s*["']([\w-]+)["']/.exec(d);
    if (m) out.add(m[1]);
  }
  const suf = /^(.+)_command$/.exec(s.name);
  if (suf) out.add(suf[1]);
  return [...out];
}

export function expandOneHop(top: Candidate[], index: IndexApi, terms: string[] = []): RankedList[] {
  const all = index.symbols();
  const byId = new Map(all.map((s) => [s.id, s]));
  const code = all.filter(isCode);
  const sources = top.map((c) => byId.get(c.id)).filter((s): s is SymbolEntry => !!s && isCode(s) && categoryOf(s) !== 'test').slice(0, 10);
  const termToks = new Set(terms.flatMap(termTokens));

  const lists: Record<'calls' | 'called-by' | 'registers' | 'tests' | 'documents', Candidate[]> = {
    calls: [], 'called-by': [], registers: [], tests: [], documents: [],
  };
  const seen: Record<string, Set<string>> = { calls: new Set(), 'called-by': new Set(), registers: new Set(), tests: new Set(), documents: new Set() };
  const push = (kind: keyof typeof lists, s: SymbolEntry, from: SymbolEntry) => {
    if (s.id === from.id || seen[kind].has(s.id)) return;
    seen[kind].add(s.id);
    lists[kind].push(fromSymbol(s, [{ kind, from: from.qualifiedName }]));
  };

  for (const src of sources) {
    // calls / called-by
    for (const n of src.calls) {
      const hit = index.byName(n).filter((x) => isCode(x) && categoryOf(x) !== 'test');
      if (hit.length === 1) push('calls', hit[0], src); // ambiguous names (pop, get, ...) would only add noise
    }
    const callers = code.filter((c) => c.id !== src.id && categoryOf(c) !== 'test' && c.calls.includes(src.name));
    if (callers.length <= 5) for (const c of callers) push('called-by', c, src);

    // registers: decorator siblings in the file, and symbols whose add_command(...) call site mentions the name
    const wr = wordRe(src.name);
    // A generic name ("command", "get") says little about tests/docs; require a distinctive one.
    const distinctive = src.name.length >= 5 && index.byName(src.name).filter(isCode).length <= 2;
    if (src.decorators.some((d) => REG_DECORATOR.test(d))) {
      for (const sib of index.inFile(src.path)) {
        if (sib.id !== src.id && isCode(sib) && sib.decorators.some((d) => REG_DECORATOR.test(d))) push('registers', sib, src);
      }
    }
    for (const c of code) {
      if (c.id !== src.id && categoryOf(c) !== 'test' && c.calls.includes('add_command') && wr.test(c.text)) push('registers', c, src);
    }

    // tests: reference by name, plus tests in test_<module>.py that match request terms
    const names = [src.name, ...cliNames(src)];
    const testSyms = code.filter((c) => c.kind === 'test');
    let n = 0;
    for (const t of distinctive ? testSyms : []) {
      if (n >= 3) break;
      if (t.calls.includes(src.name) || wr.test(t.text)) { push('tests', t, src); n++; }
    }
    const mod = src.path.replace(/^.*\//, '').replace(/\.py$/, '');
    const inModule = testSyms
      .filter((t) => new RegExp(`(^|/)test_${escapeRe(mod)}\\.py$`).test(t.path))
      .map((t) => ({ t, hit: tokenize(`${t.name} ${t.text}`).filter((x) => termToks.has(x)).length + names.filter((nm) => wordRe(nm).test(t.text)).length * 2 }))
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit || a.t.startLine - b.t.startLine)
      .slice(0, 3);
    for (const { t } of inModule) push('tests', t, src);

    // documents: doc sections naming the symbol or its CLI name
    const docHits = all
      .filter((d) => d.kind === 'doc' && (distinctive || cliNames(src).length > 0))
      .map((d) => {
        let score = distinctive && wr.test(d.text) ? 2 : 0;
        for (const nm of cliNames(src)) if (wordRe(nm).test(d.text)) score += 1;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.d.id.localeCompare(b.d.id))
      .slice(0, 3);
    for (const { d } of docHits) push('documents', d, src);
  }
  return (Object.keys(lists) as Array<keyof typeof lists>)
    .map((k) => ({ name: k, items: lists[k], weight: k === 'registers' ? 0.8 : 0.5 }))
    .filter((l) => l.items.length);
}

// ------------------------------------------------------------------ 4. RRF

export function rrfFuse(lists: RankedList[], k = 60): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const l of lists) {
    l.items.forEach((c, i) => {
      const cur = byId.get(c.id);
      const add = (l.weight ?? 1) / (k + i + 1);
      if (cur) {
        cur.score += add;
        for (const r of c.reasons) if (!cur.reasons.some((x) => sameReason(x, r))) cur.reasons.push(r);
      } else {
        byId.set(c.id, { ...c, score: add, reasons: [...c.reasons] });
      }
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ 5. packing

const overlaps = (a: { path: string; startLine: number; endLine: number }, b: { path: string; startLine: number; endLine: number }) =>
  a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;

/** Signature (+ decorators) + docstring + term-matching lines, capped at `capTokens`; marked with [trimmed]. */
function trimText(c: Candidate, terms: string[], capTokens: number): string {
  const lines = c.text.split('\n');
  const keep = new Set<number>();
  const marker = c.category === 'docs' ? '.. [trimmed]' : '# ... [trimmed]';
  if (c.category === 'docs') {
    keep.add(0);
    if (lines.length > 1) keep.add(1);
  } else {
    let i = 0;
    while (i < lines.length && /^\s*@/.test(lines[i])) keep.add(i++);
    for (; i < lines.length; i++) {
      keep.add(i);
      if (/:\s*(#.*)?$/.test(lines[i])) break;
    }
    // docstring
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const q = /^\s*[rRbBuU]?("""|''')/.exec(lines[j] ?? '');
    if (q) {
      const closeAt = (ln: string, from: number) => ln.indexOf(q[1], from);
      let e = j;
      if (closeAt(lines[j], lines[j].indexOf(q[1]) + 3) < 0) {
        e = j + 1;
        while (e < lines.length && closeAt(lines[e], 0) < 0) e++;
      }
      for (let x = j; x <= Math.min(e, lines.length - 1); x++) keep.add(x);
    }
  }
  const render = () => {
    const out: string[] = [];
    let prev = -1;
    [...keep].sort((a, b) => a - b).forEach((i) => {
      if (prev >= 0 && i > prev + 1) out.push(marker);
      out.push(lines[i]);
      prev = i;
    });
    if (prev < lines.length - 1) out.push(marker);
    return out.join('\n');
  };
  const tk = new Set(terms.flatMap(termTokens));
  for (const r of c.reasons) if (r.kind === 'lexical' || r.kind === 'symbol-name') termTokens(r.term).forEach((t) => tk.add(t));
  const matching = lines
    .map((l, i) => ({ i, hit: tokenize(l).filter((t) => tk.has(t)).length }))
    .filter((x) => x.hit > 0 && !keep.has(x.i))
    .sort((a, b) => b.hit - a.hit || a.i - b.i);
  let text = render();
  for (const m of matching) {
    keep.add(m.i);
    const next = render();
    if (count(next) > capTokens) { keep.delete(m.i); continue; }
    text = next;
  }
  // Hard cap if signature + docstring alone are too large.
  while (count(text) > capTokens && text.length > 40) text = text.slice(0, Math.floor(text.length * 0.8)) + `\n${marker}`;
  return text;
}

export function pack(
  mandatory: Candidate[],
  ranked: Candidate[],
  budget: number,
  terms: string[] = [],
): { excerpts: Excerpt[]; omitted: ContextPacket['omitted'] } {
  const excerpts: Excerpt[] = [];
  const omitted: ContextPacket['omitted'] = [];
  let used = 0;
  const cap = Math.floor(budget * 0.3);
  const fileCount = new Map<string, number>();

  const omit = (c: Candidate, reason: ContextPacket['omitted'][number]['reason'], tokens = count(c.text)) =>
    omitted.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, reason, tokens });

  /** Adds `c` if it neither overlaps nor overflows. Returns true when added. */
  const tryAdd = (c: Candidate, why: 'mandatory' | 'ranked'): boolean => {
    const same = excerpts.find((e) => e.id === c.id);
    if (same) {
      for (const r of c.reasons) if (!same.reasons.some((x) => sameReason(x, r))) same.reasons.push(r);
      return false;
    }
    if (excerpts.some((e) => overlaps(e, c))) { omit(c, 'duplicate'); return false; }
    let text = c.text;
    let tokens = count(text);
    if (tokens > cap) {
      text = trimText(c, terms, cap);
      tokens = count(text);
    }
    if (used + tokens > budget) { omit(c, 'over-budget', count(c.text)); return false; }
    used += tokens;
    fileCount.set(c.path, (fileCount.get(c.path) ?? 0) + 1);
    excerpts.push({ id: c.id, path: c.path, startLine: c.startLine, endLine: c.endLine, category: c.category, tokens, score: c.score, reasons: [...c.reasons], text });
    void why;
    return true;
  };

  // 1. mandatory
  for (const m of mandatory) tryAdd(m, 'mandatory');

  // Top 40 by fused score, and nothing scoring under 50% of the best (a weak tail is noise, not context).
  const floor = (ranked[0]?.score ?? 0) * MIN_REL_SCORE;
  const cut = Math.min(TOP_N, ranked.filter((c) => c.score >= floor).length);
  const eligible = ranked.slice(0, cut);
  const rest = ranked.slice(cut);
  const taken = new Set<string>();
  const markTaken = (c: Candidate) => taken.add(c.id);

  // 2. coverage quota: best test and best docs candidate
  for (const cat of ['test', 'docs'] as const) {
    if (excerpts.some((e) => e.category === cat && e.reasons.some((r) => r.kind !== 'mention' && r.kind !== 'selection'))) continue;
    const best = ranked.find((c) => c.category === cat && !taken.has(c.id)); // from the whole list, not just above the score floor
    if (best) { markTaken(best); tryAdd(best, 'ranked'); }
  }

  // 3. greedy by score/tokens with the per-file penalty
  const pool = eligible.filter((c) => !taken.has(c.id));
  const restLeft = rest.filter((c) => !taken.has(c.id));
  const density = (c: Candidate) => {
    const pen = (fileCount.get(c.path) ?? 0) >= 3 ? 0.5 : 1;
    return (c.score * pen) / Math.max(400, Math.min(count(c.text), cap));
  };
  while (pool.length) {
    let bi = 0;
    for (let i = 1; i < pool.length; i++) if (density(pool[i]) > density(pool[bi])) bi = i;
    const [c] = pool.splice(bi, 1);
    tryAdd(c, 'ranked');
  }

  // 4. lower-rank: a bounded sample of what was below the cut
  for (const c of restLeft.slice(0, MAX_OMITTED_LOWER)) omit(c, 'lower-rank');
  return { excerpts, omitted };
}

// ------------------------------------------------------------------ 6. graph

export function buildGraph(request: string, _terms: string[], excerpts: Excerpt[]): ContextPacket['graph'] {
  const nodes: ContextPacket['graph']['nodes'] = [{ id: 'req', label: request.length > 60 ? `${request.slice(0, 57)}...` : request, type: 'request' }];
  const edges: ContextPacket['graph']['edges'] = [];
  const have = new Set<string>(['req']);
  const edgeKeys = new Set<string>();
  const node = (id: string, label: string, type: ContextPacket['graph']['nodes'][number]['type']) => {
    if (have.has(id)) return;
    have.add(id);
    nodes.push({ id, label, type });
  };
  const edge = (from: string, to: string, label: string, inferred: boolean) => {
    const k = `${from}|${to}|${label}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, label, inferred });
  };
  const symId = (e: Excerpt) => `sym:${e.path}:${e.startLine}`;
  const symLabel = (e: Excerpt) => (e.id.includes('#') ? e.id.slice(e.id.indexOf('#') + 1).replace(/@\d+$/, '') : e.path);

  for (const e of excerpts) {
    const fid = `file:${e.path}`;
    node(fid, e.path, 'file');
    node(symId(e), symLabel(e), 'symbol');
    edge(fid, symId(e), 'contains', false);
  }
  for (const e of excerpts) {
    const fid = `file:${e.path}`;
    const sid = symId(e);
    for (const r of e.reasons) {
      switch (r.kind) {
        case 'lexical':
        case 'symbol-name': {
          const tid = `term:${r.term}`;
          node(tid, r.term, 'term');
          edge('req', tid, 'term', false);
          edge(tid, fid, r.kind === 'lexical' ? `lexical:"${r.term}"` : `name:"${r.term}"`, false);
          break;
        }
        case 'mention':
          edge('req', fid, `mention ${r.token}`, false);
          break;
        case 'selection':
          edge('req', fid, 'selection', false);
          break;
        default: {
          const src = excerpts.find((x) => symLabel(x) === r.from && x !== e);
          const inferred = r.kind === 'registers' || r.kind === 'tests' || r.kind === 'documents';
          edge(src ? symId(src) : fid, sid, r.kind, inferred);
        }
      }
    }
  }
  return { nodes, edges };
}

// ------------------------------------------------------------------ assemble

let seq = 0;

export async function assembleContext(i: AssembleInput, index: IndexApi): Promise<ContextPacket> {
  const budget = i.budget ?? DEFAULT_BUDGET;
  const { terms, mandatory } = extractAnchors(i.request, i.mentions ?? [], i.selection, index, budget);
  const primary = await candidateLists(terms, index, i.rg);
  const firstPass = rrfFuse(primary);
  const topImpl = firstPass.filter((c) => c.category !== 'docs').slice(0, 10);
  const expanded = expandOneHop(topImpl, index, terms);
  const ranked = rrfFuse([...primary, ...expanded]);
  const { excerpts, omitted } = pack(mandatory, ranked, budget, terms);
  const used = excerpts.reduce((n, e) => n + e.tokens, 0);
  return {
    id: `ctx-${i.runId}-${++seq}`,
    runId: i.runId,
    query: i.request,
    budget,
    used,
    excerpts,
    omitted,
    graph: buildGraph(i.request, terms, excerpts),
  };
}

function reasonText(r: Reason): string {
  switch (r.kind) {
    case 'mention': return `mention ${r.token}`;
    case 'selection': return 'selection';
    case 'lexical': return `lexical "${r.term}" #${r.rank}`;
    case 'symbol-name': return `name "${r.term}" #${r.rank}`;
    default: return `${r.kind} ${r.from}`;
  }
}

/** Text handed to the model: budget line, excerpts under headers, then the Omitted list. */
export function formatForModel(p: ContextPacket): string {
  const out: string[] = [];
  out.push(`Context for: ${p.query}`);
  out.push(`Budget: ${p.used}/${p.budget} tokens used (≈ estimated)`);
  out.push('');
  for (const e of p.excerpts) {
    const reasons = e.reasons.length ? e.reasons.map(reasonText).join('; ') : 'no reason recorded';
    out.push(`### ${e.path}:${e.startLine}-${e.endLine} · ${e.category} · ${reasons} · ≈${e.tokens} tokens`);
    out.push('```');
    out.push(e.text);
    out.push('```');
    out.push('');
  }
  out.push('## Omitted');
  if (p.omitted.length === 0) out.push('(none)');
  for (const o of p.omitted) {
    out.push(`- ${o.path}:${o.startLine}-${o.endLine} · ${o.reason} · ≈${o.tokens} tokens`);
  }
  return out.join('\n');
}
