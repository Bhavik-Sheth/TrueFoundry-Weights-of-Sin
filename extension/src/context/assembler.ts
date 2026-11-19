/**
 * context/assembler.ts - C3 budgeted hybrid retrieval (assemble_context). The core novel file.
 *
 * S0 status: final signatures. assembleContext returns samplePacket (STUB); formatForModel is REAL;
 * extractAnchors/candidateLists/expandOneHop/rrfFuse/pack/buildGraph are minimal stubs filled in Slice 5.
 *
 * Exports:
 *  - assembleContext({request, mentions?, budget?, selection?, runId}, index): ContextPacket.
 *  - extractAnchors(request, mentions, selection): identifiers, quoted strings, CLI-ish words,
 *    capitalised constants; stopwords dropped; @path / @name mentions resolved.
 *  - candidateLists(terms, index): BM25 symbols, BM25 docs, symbol-name, ripgrep lists.
 *  - expandOneHop(top10, index): calls/called-by, registers (@click.command, @app.cli.command,
 *    cli.add_command), tests (test_<module>.py or bodies referencing the name), documents.
 *    Each expanded item carries a Reason naming its source.
 *  - rrfFuse(lists, k = 60): score = sum 1/(k + rank_i) across lists; keeps contributing reasons.
 *  - pack(mandatory, ranked, budget): mandatory first, then greedy score/tokens; merge overlapping
 *    ranges; duplicate penalty past 3 excerpts per file; coverage quota reserves best test and best doc;
 *    symbols > 30% of budget cut to signature + docstring + matching lines.
 *  - buildGraph(request, terms, excerpts): request -> terms -> files -> symbols with labelled edges (inferred flag).
 *  - formatForModel(packet): budget line, "### path:start-end . impl|test|docs . reason . ~tokens" headers, Omitted list.
 *
 * Rules: pure (no vscode import); every omission carries a reason (duplicate | lower-rank | over-budget);
 * target < 1 s at 8k budget.
 * Depends on: context/search, context/indexer (type), context/tokens, dev/fixtures (S0 only), types.
 * Depended on by: mcp/tools; output consumed by shell/panel (Context tab).
 */
import type { ContextPacket, Excerpt, Reason, Selection } from '../types';
import type { IndexApi } from './indexer';
import { samplePacket } from '../dev/fixtures';

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
}

export interface AssembleInput {
  request: string;
  mentions?: string[];
  budget?: number;
  selection?: Selection;
  runId: string;
}

export function extractAnchors(
  request: string,
  mentions: string[] = [],
  sel?: Selection,
): { terms: string[]; mandatory: Candidate[] } {
  console.debug('[stub] extractAnchors', request, mentions, sel?.path);
  return { terms: [], mandatory: [] };
}

export async function candidateLists(terms: string[], index: IndexApi): Promise<RankedList[]> {
  console.debug('[stub] candidateLists', terms, index.symbols().length);
  return [];
}

export function expandOneHop(top: Candidate[], index: IndexApi): RankedList[] {
  console.debug('[stub] expandOneHop', top.length, index.symbols().length);
  return [];
}

export function rrfFuse(lists: RankedList[], k = 60): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const l of lists) {
    l.items.forEach((c, i) => {
      const cur = byId.get(c.id);
      const add = 1 / (k + i + 1);
      if (cur) {
        cur.score += add;
        cur.reasons.push(...c.reasons);
      } else {
        byId.set(c.id, { ...c, score: add, reasons: [...c.reasons] });
      }
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

export function pack(
  mandatory: Candidate[],
  ranked: Candidate[],
  budget: number,
): { excerpts: Excerpt[]; omitted: ContextPacket['omitted'] } {
  console.debug('[stub] pack', mandatory.length, ranked.length, budget);
  return { excerpts: [], omitted: [] };
}

export function buildGraph(request: string, terms: string[], excerpts: Excerpt[]): ContextPacket['graph'] {
  console.debug('[stub] buildGraph', request, terms.length, excerpts.length);
  return { nodes: [{ id: 'req', label: request, type: 'request' }], edges: [] };
}

export async function assembleContext(i: AssembleInput, index: IndexApi): Promise<ContextPacket> {
  console.debug('[stub] assembleContext', i.runId, index.symbols().length);
  return { ...samplePacket, runId: i.runId, query: i.request, budget: i.budget ?? samplePacket.budget };
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
