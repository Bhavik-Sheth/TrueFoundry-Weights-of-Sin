import { posix } from 'node:path';
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
import { corpusNeighbors } from './corpusVectors';
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
  if (/(^|\/)tests?\//.test(s.path) || /(^|\/)test_[^/]*$|_test\.go$/.test(s.path)) return 'test';
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
    mandatory.push({
      id: `${sel.path}#sel@${sel.startLine + 1}`,
      path: sel.path, startLine: sel.startLine + 1, endLine: sel.endLine + 1,
      category: categoryOf({ path: sel.path }), text: sel.text, score: 1, reasons: [reason],
    });
  }
  const anchors = mentions.filter(mention => mention.startsWith('@') || looksLikePath(mention));
  if (index) for (const mention of anchors) mandatory.push(...mentionCandidates(mention, terms, index, budget));
  // Tool clients may put search words in mentions. Only explicit anchors reserve source.
  const hints = extractTerms(mentions.filter(mention => !anchors.includes(mention)).join(' '));
  const query = [...new Set([...terms, ...hints])].slice(0, 30);
  const seen = new Map<string, Candidate>();
  for (const c of mandatory) {
    const cur = seen.get(c.id);
    if (cur) cur.reasons.push(...c.reasons); else seen.set(c.id, c);
  }
  return { terms: query, mandatory: [...seen.values()] };
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

// SymbolIndex returns a new array when source is reindexed. Cache by that snapshot
// so reindexing cannot reuse obsolete postings, while unchanged turns share the index.
const searchSnapshots = new WeakMap<SymbolEntry[], ReturnType<typeof buildSearchSnapshot>>();

function buildSearchSnapshot(symbols: SymbolEntry[]) {
  const code = symbols.filter(isCode);
  const docs = symbols.filter(symbol => symbol.kind === 'doc');
  const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
  const files = new Map<string, SymbolEntry[]>();
  for (const symbol of symbols) {
    const items = files.get(symbol.path) ?? [];
    items.push(symbol);
    files.set(symbol.path, items);
  }
  const pathTerms = new Map<string, string[]>();
  for (const path of files.keys()) for (const term of new Set(tokenize(path))) {
    const paths = pathTerms.get(term) ?? [];
    paths.push(path);
    pathTerms.set(term, paths);
  }
  const postings = new Map<string, number[]>();
  for (const [id, { path, qualifiedName, text }] of code.entries()) {
    for (const token of new Set(tokenize(`${path} ${qualifiedName} ${text}`))) {
      const items = postings.get(token);
      if (items) items.push(id);
      else postings.set(token, [id]);
    }
  }
  const docFrequency = (term: string) => {
    const matches = termTokens(term).map(token => postings.get(token) ?? []);
    if (!code.length) return 0;
    if (matches.length === 1) return matches[0].length / code.length;
    const unique = new Set<number>();
    for (const list of matches) for (const id of list) unique.add(id);
    return unique.size / code.length;
  };
  const bm25 = (items: SymbolEntry[]) => new Bm25(items.map(symbol => ({
    id: symbol.id,
    text: `${symbol.qualifiedName} ${symbol.qualifiedName} ${symbol.path} ${symbol.decorators.join(' ')} ${symbol.text}`,
  })));
  return { code, docs, byId, files, pathTerms, rankedQueries: new Map<string, RankedList[]>(), docFrequency, codeRanker: bm25(code), docRanker: bm25(docs) };
}

export async function candidateLists(terms: string[], index: IndexApi, rg?: RgFn): Promise<RankedList[]> {
  const all = index.symbols();
  if (!terms.length) return [];
  let snapshot = searchSnapshots.get(all);
  if (!snapshot) {
    snapshot = buildSearchSnapshot(all);
    searchSnapshots.set(all, snapshot);
  }
  const { code, docs, byId, docFrequency: dfOf, codeRanker, docRanker } = snapshot;
  const lists: RankedList[] = [];

  // Drop non-discriminating terms (present in > 30% of code symbols).
  const useful = terms.filter(t => termTokens(t).length > 0 && dfOf(t) <= 0.3);
  const q = useful.length ? useful : terms;
  const bm = (name: string, ranker: Bm25): RankedList => {
    const ranked = ranker.rank(q, LIST_CAP);
    return {
      name,
      items: ranked.map((r, i) => {
        const s = byId.get(r.id)!;
        const term = firstMatchingTerm(`${s.qualifiedName} ${s.text}`, q) ?? q[0];
        return fromSymbol(s, [{ kind: 'lexical', term, rank: i + 1 }]);
      }),
    };
  };
  const queryKey = JSON.stringify(q);
  const cached = snapshot.rankedQueries.get(queryKey);
  if (cached) {
    snapshot.rankedQueries.delete(queryKey);
    snapshot.rankedQueries.set(queryKey, cached);
    lists.push(...cached);
  } else {
    lists.push({ name: 'corpus-vectors', weight: 0.35, items: corpusNeighbors(all, q, LIST_CAP)
      .map(({ symbol }, i) => fromSymbol(symbol, [{ kind: 'semantic', rank: i + 1 }])) });
    lists.push(bm('bm25-symbols', codeRanker));
    if (docs.length) lists.push(bm('bm25-docs', docRanker));

    const names = symbolNameMatch(q.flatMap((t) => [t, ...termTokens(t)]), code)
      .filter((m) => m.score === 3 || (m.score === 2 && m.term.length >= 5))
      .slice(0, LIST_CAP);
    lists.push({
      name: 'symbol-name',
      items: names.map((m, i) => fromSymbol(m.symbol, [{ kind: 'symbol-name', term: m.term, rank: i + 1 }])),
    });
    if (snapshot.rankedQueries.size >= 48) snapshot.rankedQueries.delete(snapshot.rankedQueries.keys().next().value!);
    snapshot.rankedQueries.set(queryKey, [...lists]);
  }

  // Ripgrep: only the most specific terms; hits mapped to their enclosing symbol.
  const run = rg ?? defaultRg();
  const rgTerms = q.filter((t) => t.length >= 3 && dfOf(t) <= 0.08).slice(0, 4); // only distinctive terms are worth a grep
  const hitsByTerm = await Promise.all(rgTerms.map(async (t) => ({ t, hits: await run(t).catch(() => []) })));
  const agg = new Map<string, { sym: SymbolEntry; terms: Set<string>; n: number }>();
  const raw = new Map<string, { candidate: Candidate; terms: Set<string> }>();
  for (const { t, hits } of hitsByTerm) {
    for (const h of hits) {
      const sym = index.enclosing(h.path, h.line);
      if (!sym) {
        if (!/\.(?:go|rs)$/.test(h.path) || !h.preview.trim() || h.line < 1) continue;
        const id = JSON.stringify([h.path, h.line]);
        const item = raw.get(id) ?? {
          candidate: { id, path: h.path, startLine: h.line, endLine: h.line, category: categoryOf(h),
            text: h.preview.slice(0, 200), score: 0, reasons: [] },
          terms: new Set<string>(),
        };
        item.terms.add(t);
        raw.set(id, item);
        continue;
      }
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
  if (raw.size) {
    // A declaration is a stronger starting point than a comment or incidental use.
    const declaration = ({ candidate, terms }: { candidate: Candidate; terms: Set<string> }) =>
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:func|fn|struct|enum|trait|type|const)\s+/.test(candidate.text)
      && [...terms].some(term => wordRe(term).test(candidate.text.toLowerCase()));
    const perFile = new Map<string, number>();
    const selected = [...raw.values()].sort((a, b) =>
      Number(declaration(b)) - Number(declaration(a)) || b.terms.size - a.terms.size).filter(({ candidate }) => {
      const count = perFile.get(candidate.path) ?? 0;
      if (count >= 3) return false;
      perFile.set(candidate.path, count + 1);
      return true;
    }).slice(0, 12);
    lists.push({ name: 'source-preview', items: selected.map(({ candidate, terms }, rank) => ({
      ...candidate, reasons: [{ kind: 'source-preview', term: [...terms][0], rank: rank + 1 }],
    })) });
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

function moduleMatches(module: string, source: string, target: string): boolean {
  const relative = /^\.+/.exec(module)?.[0].length ?? 0;
  const name = module.slice(relative).replace(/\./g, '/');
  const folder = target.endsWith('/__init__.py') ? target.slice(0, -12) : target.replace(/\.py$/, '');
  if (relative) {
    const parent = posix.join(posix.dirname(source), ...Array<string>(relative - 1).fill('..'));
    return folder === posix.join(parent, name);
  }
  return folder === name || folder.endsWith('/' + name);
}

function featureCandidates(index: IndexApi, request: string, terms: string[]): Candidate[] {
  const snapshot = searchSnapshots.get(index.symbols());
  if (!snapshot) return [];
  const query = new Set(terms.flatMap(tokenize));
  const feature = [...query].flatMap(term => {
    const paths = snapshot.pathTerms.get(term);
    if (term.length < 4 || !paths || paths.length > Math.max(12, snapshot.files.size * 0.045) ||
        new Set(paths.map(path => categoryOf({ path }))).size !== 3) return [];
    const folder = paths.filter(path => posix.dirname(path).split('/').includes(term)).length;
    // A module name alone is weak evidence for feature scope in a CLI change.
    if (folder < 2) return [];
    const guide = paths.some(path => path.startsWith('docs/') && posix.basename(path, posix.extname(path)) === term);
    return [{ term, score: Math.min(8, folder) * 3 + (guide ? 4 : 0) }];
  }).sort((a, b) => b.score - a.score)[0]?.term;
  const cli = /\b(?:cli|subcommands?|command.line)\b/i.test(request);
  const cliFlags = cli ? [...new Set([...request.matchAll(/--[a-z][\w-]*/gi)].map(match => match[0].toLowerCase())
    .concat(terms.filter(term => /^[a-z][a-z0-9-]+$/.test(term)).map(term => '--' + term)))] : [];
  const cliEntry = cliFlags.length ? snapshot.code.find(symbol => symbol.decorators.some(decorator => {
    const match = /^click\.option\(\s*["'](--[\w-]+)["']/.exec(decorator);
    return match && cliFlags.includes(match[1].toLowerCase());
  })) : undefined;
  if (!feature) {
    if (!cliEntry) return [];
    const name = posix.basename(cliEntry.path, '.py').replace(/^_/, '');
    const test = [...snapshot.files.values()].find(entries => entries[0].path.startsWith('tests/') &&
      posix.basename(entries[0].path) === `test_${name}.py`)?.[0];
    const guide = [...snapshot.files.values()].find(entries => {
      const stem = posix.basename(entries[0].path, posix.extname(entries[0].path));
      return entries[0].path.startsWith('docs/') && cliFlags.some(flag => flag.slice(2) === stem || flag.slice(2) + 's' === stem);
    })?.[0];
    return [fromSymbol(cliEntry, [{ kind: 'symbol-name', term: cliEntry.name, rank: 1 }]),
      ...(test ? [fromSymbol(test, [{ kind: 'tests', from: cliEntry.qualifiedName }])] : []),
      ...(guide ? [fromSymbol(guide, [{ kind: 'documents', from: cliEntry.qualifiedName }])] : [])];
  }
  const readOnly = /\bread[ -]only\b/i.test(request);
  const candidates = (snapshot.pathTerms.get(feature) ?? []).map(path => {
    const symbols = snapshot.files.get(path) ?? [];
    const ranked = symbols.map(symbol => {
      const lexical = [...new Set(tokenize(symbol.qualifiedName + ' ' + symbol.text))].filter(term => query.has(term)).length;
      const read = readOnly && /\bhttp_request\(\s*["']GET["']/.test(symbol.text) ? 6 : 0;
      return { symbol, score: lexical + read };
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) return undefined;
    const cliPath = cli && /(?:^|[/_])cli(?:[/_.]|$)/.test(path) ? 12 : 0;
    const writes = readOnly && symbols.some(item => /\bhttp_request\(\s*["'](?:POST|PUT|PATCH|DELETE)["']/.test(item.text));
    const publicDocs = path.startsWith('docs/') && !path.startsWith('docs/design/') ? 4 : 0;
    return { symbol: best.symbol, score: best.score + cliPath + publicDocs - (writes ? 16 : 0) };
  }).filter(item => item !== undefined).sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path));
  return (['impl', 'test', 'docs'] as const).flatMap(category => candidates
    .filter(item => categoryOf(item.symbol) === category).slice(0, category === 'impl' ? 3 : 1))
    .map(({ symbol }, rank) => fromSymbol(symbol, [{ kind: 'feature-path', term: feature, rank: rank + 1 }]));
}

export function expandOneHop(top: Candidate[], index: IndexApi, terms: string[] = []): RankedList[] {
  const all = index.symbols();
  const byId = new Map(all.map((s) => [s.id, s]));
  const code = all.filter(isCode);
  const sources = top.map((c) => byId.get(c.id)).filter((s): s is SymbolEntry => !!s && isCode(s) && categoryOf(s) !== 'test').slice(0, 10);
  const termToks = new Set(terms.flatMap(termTokens));
  const linked = new Map<string, SymbolEntry[]>();
  const targets = (source: SymbolEntry) => {
    let edges = linked.get(source.id);
    if (!edges) {
      edges = (source.boundCalls ?? []).flatMap(call => {
        const matches = index.byName(call.name).filter(candidate =>
          candidate.qualifiedName === call.name && moduleMatches(call.module, source.path, candidate.path));
        if (matches.length) return matches.length === 1 ? matches : [];
        const reexport = index.resolveReexport?.(source.path, call.module, call.name);
        return reexport ? [reexport] : [];
      });
      linked.set(source.id, edges);
    }
    return edges;
  };

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
    for (const target of targets(src)) push('calls', target, src);
    for (const n of src.calls) {
      if (src.boundCalls?.some(call => call.spelling === n)) continue;
      const hit = index.byName(n).filter((x) => isCode(x) && categoryOf(x) !== 'test');
      if (hit.length === 1) push('calls', hit[0], src); // ambiguous names (pop, get, ...) would only add noise
    }
    const callers = code.filter(c => c.id !== src.id && categoryOf(c) !== 'test' &&
      (targets(c).some(target => target.id === src.id) ||
       (c.calls.includes(src.name) && !c.boundCalls?.some(call => call.spelling === src.name))));
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
    for (const t of testSyms) {
      if (n >= 3) break;
      if (targets(t).some(target => target.id === src.id) || (distinctive && (t.calls.includes(src.name) || wr.test(t.text)))) { push('tests', t, src); n++; }
    }
    const mod = src.path.replace(/^.*\//, '').replace(/\.py$/, '');
    const inModule = testSyms
      .filter((t) => new RegExp(`(^|/)test_${escapeRe(mod)}\\.py$`).test(t.path))
      .map((t) => ({ t, hit: tokenize(`${t.name} ${t.text}`).filter((x) => termToks.has(x)).length + names.filter((nm) => wordRe(nm).test(t.text)).length * 2 }))
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit || a.t.startLine - b.t.startLine)
      .slice(0, 3);
    for (const { t } of inModule) push('tests', t, src);

    // Prefer a matching module guide when it also overlaps the query or names the command.
    const commandNames = cliNames(src);
    const docHits = all
      .filter(d => d.kind === 'doc')
      .map(d => {
        const named = distinctive && wr.test(d.text) ? 2 : 0;
        const aliases = commandNames.filter(name => wordRe(name).test(d.text)).length;
        const sameModule = d.path.startsWith('docs/') && posix.basename(d.path, posix.extname(d.path)) === mod;
        const overlap = sameModule ? tokenize(d.name + ' ' + d.text).filter(term => termToks.has(term)).length : 0;
        return { d, score: named + aliases + (overlap ? 3 + Math.min(3, overlap) : 0) };
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
  const lineLimit = Math.min(1200, Math.max(120, capTokens * 3));
  const lines = c.text.split('\n').map(line => line.length > lineLimit ? line.slice(0, lineLimit) + ' [trimmed]' : line);
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

// Coordinate suggestions come from the untrimmed indexed excerpt. read_file confirms current text.
function readRange(candidate: Candidate, terms: string[]) {
  const lines = candidate.text.split('\n');
  const vocabulary = new Set(terms.flatMap(tokenize));
  const width = Math.min(16, lines.length, candidate.endLine - candidate.startLine + 1);
  const scores = lines.map(line => tokenize(line).filter(term => vocabulary.has(term)).length);
  let best = 0;
  let total = scores.slice(0, width).reduce((sum, score) => sum + score, 0);
  let max = total;
  for (let i = width; i < lines.length; i++) {
    total += scores[i] - scores[i - width];
    if (total > max) {
      max = total;
      best = i - width + 1;
    }
  }
  const startLine = Math.min(candidate.endLine, candidate.startLine + best);
  return { startLine, endLine: Math.min(candidate.endLine, startLine + width - 1) };
}

export function pack(
  mandatory: Candidate[],
  ranked: Candidate[],
  budget: number,
  terms: string[] = [],
  scope: Candidate[] = [],
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
      if (why === 'mandatory') same.priority = true;
      return false;
    }
    if (excerpts.some((e) => overlaps(e, c))) { omit(c, 'duplicate'); return false; }
    let text = c.text;
    let tokens = count(text);
    const scoped = scope.includes(c);
    const limit = scoped ? Math.min(cap, 220, Math.floor(budget / (scope.length + 1))) : cap;
    if (tokens > limit) {
      text = trimText(c, terms, limit);
      tokens = count(text);
    }
    if (used + tokens > budget) { omit(c, 'over-budget', count(c.text)); return false; }
    used += tokens;
    fileCount.set(c.path, (fileCount.get(c.path) ?? 0) + 1);
    excerpts.push({ id: c.id, path: c.path, startLine: c.startLine, endLine: c.endLine, category: c.category, tokens, score: c.score, reasons: [...c.reasons], priority: why === 'mandatory' || undefined, readRange: scoped ? readRange(c, terms) : undefined, text });
    return true;
  };

  // 1. mandatory
  for (const m of mandatory) tryAdd(m, 'mandatory');
  const coverage = (['impl', 'test', 'docs'] as const).map(category => scope.find(candidate => candidate.category === category));
  for (const candidate of new Set([...coverage, ...scope])) if (candidate) tryAdd(candidate, 'mandatory');

  // Top 40 by fused score, and nothing scoring under 50% of the best (a weak tail is noise, not context).
  const floor = (ranked[0]?.score ?? 0) * MIN_REL_SCORE;
  const cut = Math.min(TOP_N, ranked.filter((c) => c.score >= floor).length);
  const eligible = ranked.slice(0, cut);
  const rest = ranked.slice(cut);
  const taken = new Set<string>();
  const markTaken = (c: Candidate) => taken.add(c.id);

  if (!excerpts.some(e => e.category === 'impl') && !eligible.some(c => c.category === 'impl')) {
    const preview = ranked.find(c => c.category === 'impl' && c.reasons.some(r => r.kind === 'source-preview'));
    if (preview) { markTaken(preview); tryAdd(preview, 'ranked'); }
  }

  // 2. coverage quota: link the reserved docs to the leading implementation when evidence exists.
  const implementation = excerpts.find(e => e.category === 'impl') ?? ranked.find(c => c.category === 'impl');
  const module = implementation ? posix.basename(implementation.path, posix.extname(implementation.path)) : undefined;
  for (const cat of ['test', 'docs'] as const) {
    if (excerpts.some(e => e.category === cat && e.reasons.some(r => r.kind !== 'mention' && r.kind !== 'selection'))) continue;
    const candidates = ranked.filter(c => c.category === cat && !taken.has(c.id));
    const linked = candidates.find(c => cat === 'docs'
      ? c.path.startsWith('docs/') && posix.basename(c.path, posix.extname(c.path)) === module &&
        c.reasons.some(r => r.kind === 'documents')
      : posix.basename(c.path) === `test_${module}.py` && c.reasons.some(r => r.kind === 'tests'));
    const best = linked ?? candidates[0];
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
        case 'feature-path':
          edge('req', sid, `feature: ${r.term}`, true);
          break;
        case 'source-preview':
          edge('req', sid, 'search preview', false);
          break;
        case 'semantic':
          edge('req', sid, 'semantic', true);
          break;
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
  if (index.languageLinks) {
    const entries = searchSnapshots.get(index.symbols())?.byId;
    const leading = topImpl.flatMap(candidate => {
      const symbol = entries?.get(candidate.id);
      return symbol ? [symbol] : [];
    });
    const links = await index.languageLinks(leading);
    if (links.length) expanded.push({
      name: 'language-provider',
      items: links.map(({ source, target, kind }) => fromSymbol(target, [{ kind, from: source.qualifiedName }])),
    });
  }
  const ranked = rrfFuse([...primary, ...expanded]);
  const scope = i.selection || mandatory.length ? [] : featureCandidates(index, i.request, terms);
  const { excerpts, omitted } = pack(mandatory, ranked, budget, terms, scope);
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
    case 'feature-path': return `feature path ${r.term} #${r.rank}`;
    case 'semantic': return `semantic match #${r.rank}`;
    case 'source-preview': return `search preview "${r.term}" #${r.rank}; use read_file for exact source`;
    case 'lexical': return `lexical "${r.term}" #${r.rank}`;
    case 'symbol-name': return `name "${r.term}" #${r.rank}`;
    default: return `${r.kind} ${r.from}`;
  }
}

const MODEL_CHARACTER_LIMIT = 22_000;

/** Build the exact MCP text and account for the bytes of source selected for it. */
export function prepareContextForModel(packet: ContextPacket) {
  const lines = [
    `Context for: ${packet.query.slice(0, 1200)}`,
    `Budget: ${packet.used}/${packet.budget} estimated excerpt tokens packed`,
    '',
  ];
  const excerptIds: string[] = [];
  const shortenedExcerptIds: string[] = [];
  let excerptTokens = 0;
  let omittedExcerpts = 0;
  let omittedReasons = 0;
  const filePaths: string[] = [];
  let fileTokens = 0;
  const fileBudget = Math.min(1_300, Math.max(200, Math.floor(packet.budget * 0.22)));

  // JSON escaping counts toward TrueForge's character limit. Reserve space for the
  // delivery summary so every response can tell the model what was left out.
  const fits = (line: string) => JSON.stringify([...lines, line].join('\n')).length <= MODEL_CHARACTER_LIMIT - 320;
  // A compact diff sample shows one line from each side. Larger hunks stay in file_context.
  const sample = (change: NonNullable<ContextPacket['files']>[number]['changes']) => {
    const lines = change?.hunks?.flatMap(hunk => hunk.lines ?? []) ?? [];
    return ['-', '+'].flatMap(sign => {
      const line = lines.find(line => line.startsWith(sign));
      return line ? [JSON.stringify(line.slice(0, 96))] : [];
    }).join(' → ');
  };
  for (const file of packet.files ?? []) {
    const needed = file.reasons.map(reasonText).join(', ');
    const contents = file.symbols.slice(0, 3).map(symbol => `${symbol.name} L${symbol.start}–${symbol.end}`).join(', ');
    const opening = file.openingLines?.slice(0, 2).map(line => `L${line.line} ${JSON.stringify(line.text)}`).join(', ');
    const change = file.changes;
    const counts = change?.added !== undefined ? ` (+${change.added} / −${change.removed})` : '';
    const ranges = change?.hunks?.map(hunk =>
      `old L${hunk.oldStart}+${hunk.oldLines} → new L${hunk.newStart}+${hunk.newLines}`).join(', ');
    const last = file.lastCommit;
    const history = last ? ` Last file commit ${last.commit.slice(0, 12)}: ${JSON.stringify(last.subject)}.` : '';
    const summary = [
      filePaths.length ? '' : '## File map (repository evidence). Use file_context for before/after hunks or exact historical lines.',
      `- ${file.path} · needed for: ${needed || 'workspace anchor'}.`,
      contents ? `  Indexed contents: ${contents} (${file.symbolCount} total).` : opening ? `  Opening lines: ${opening}.` : '  See exact reads for file contents.',
      `  ${file.source} vs Git HEAD${file.head ? ' ' + file.head.slice(0, 12) : ''}: ${change?.status ?? 'unavailable'}${counts}.${ranges ? ' Changed ranges: ' + ranges + '.' : ''}${history}`,
    ].filter(Boolean).join('\n');
    const localSample = sample(change);
    const prior = file.previousChanges;
    const priorSample = sample(prior);
    const details = [
      localSample && `  Current change sample: ${localSample}.`,
      last?.previousPath && last.previousPath !== file.path && `  Previous path: ${JSON.stringify(last.previousPath)}.`,
      prior && `  Last commit delta: ${prior.status}${prior.added === undefined ? '' : ` (+${prior.added} / −${prior.removed})`}${last?.parent ? ` from ${last.parent.slice(0, 12)}` : ''}.${priorSample ? ' Sample: ' + priorSample + '.' : ''}`,
    ].filter(Boolean).join('\n');
    const expanded = details ? summary + '\n' + details : summary;
    const block = fileTokens + count(expanded) <= fileBudget && fits(expanded) ? expanded : summary;
    const tokens = count(block);
    if (fileTokens + tokens <= fileBudget && fits(block)) {
      filePaths.push(file.path);
      fileTokens += tokens;
      lines.push(block);
    }
  }
  if (filePaths.length) lines.push('');
  const omittedFiles = (packet.files?.length ?? 0) - filePaths.length;
  const preview = (excerpt: Excerpt, text: string, tokens: number) => {
    const reasons = excerpt.reasons.slice(0, 5).map(reasonText).join('; ');
    const range = excerpt.readRange;
    const next = range ? ` · exact read suggested L${range.startLine}–${range.endLine}` : '';
    return [
      `### ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine} · ${excerpt.category} · ${reasons} · ≈${tokens} tokens${next}`,
      '```', text, '```', '',
    ].join('\n');
  };
  const protectedIds = new Set(packet.excerpts.filter(excerpt => excerpt.priority).map(excerpt => excerpt.id));
  for (const category of ['impl', 'test', 'docs'] as const) {
    if (!packet.excerpts.some(excerpt => excerpt.priority && excerpt.category === category)) {
      const candidate = packet.excerpts.find(excerpt => excerpt.category === category);
      if (candidate) protectedIds.add(candidate.id);
    }
  }
  const protectedExcerpts = packet.excerpts.filter(excerpt => protectedIds.has(excerpt.id));
  const tail = packet.excerpts.filter(excerpt => !protectedIds.has(excerpt.id));
  const constrained = !fits(packet.excerpts.map(excerpt => preview(excerpt, excerpt.text, excerpt.tokens)).join('\n'));
  const previewBudget = Math.max(64, Math.min(260, Math.floor(2200 / Math.max(1, protectedExcerpts.length))));
  const terms = constrained ? extractTerms(packet.query) : [];
  for (const excerpt of constrained ? [...protectedExcerpts, ...tail] : packet.excerpts) {
    let text = excerpt.text;
    let tokens = excerpt.tokens;
    if (constrained && protectedIds.has(excerpt.id) && tokens > previewBudget) {
      text = trimText({ ...excerpt }, terms, previewBudget);
      tokens = count(text);
    }
    const block = preview(excerpt, text, tokens);
    if (fits(block)) {
      lines.push(block);
      excerptIds.push(excerpt.id);
      excerptTokens += tokens;
      if (text !== excerpt.text) shortenedExcerptIds.push(excerpt.id);
    } else {
      omittedExcerpts++;
    }
  }
  lines.push('## Omitted');
  if (!packet.omitted.length && !omittedExcerpts && !omittedFiles) lines.push('(none)');
  let omissionTokens = 0;
  const omissionBudget = Math.min(600, Math.floor(packet.budget * 0.12));
  for (const item of packet.omitted) {
    const line = `- ${item.path}:${item.startLine}-${item.endLine} · ${item.reason} · ≈${item.tokens} tokens`;
    const tokens = count(line);
    if (omissionTokens + tokens <= omissionBudget && fits(line)) {
      lines.push(line);
      omissionTokens += tokens;
    } else omittedReasons++;
  }
  if (omittedExcerpts || omittedReasons) {
    lines.push(`The response cap excluded ${omittedExcerpts} excerpt(s). The omission ledger clipped ${omittedReasons} detail(s). Use read_file for exact source.`);
  }
  if (omittedFiles) lines.push(`File-map budget omitted ${omittedFiles} file(s). Use file_context for specific files.`);
  const text = lines.join('\n');
  return {
    text,
    delivery: {
      excerptIds, excerptTokens, shortenedExcerptIds, packetTokens: count(text), serializedCharacters: JSON.stringify(text).length,
      characterLimit: MODEL_CHARACTER_LIMIT, omittedExcerpts, omittedReasons, filePaths, omittedFiles,
    },
  };
}

export function formatForModel(packet: ContextPacket): string {
  return prepareContextForModel(packet).text;
}
