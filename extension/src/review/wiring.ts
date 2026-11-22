/**
 * wiring.ts - before/after wiring map of a proposal (review Changes tab).
 *
 * Exports:
 *  - WiringGraph (re-exported from types.ts): nodes (callers and targets) and added/removed call/import edges.
 *  - buildWiring(impact, proposal, candidateSymbols, baseSymbols?): pure graph from compareProposalImpact output;
 *    an edge's hunkId (and hunkLine = its newStart) is the first hunk of its file overlapping the calling symbol (new side for added edges,
 *    old side against baseSymbols for removed ones). Module-level edges use the first hunk with a matching +/- line.
 *  - wiringFor(proposal, workspaceSymbols, wasmDir?): compares the proposal with every hunk accepted and builds the graph.
 *
 * Must not import 'vscode'. Depends on: impactGraph.ts, proposal.ts, indexer.ts. Depended on by: extension.ts.
 */
import { loadParser, parsePython } from '../context/indexer';
import type { Hunk, Proposal, SymbolEntry, WiringGraph } from '../types';
import { compareProposalImpact } from './impactGraph';
import { rebuildFile } from './proposal';

export type { WiringGraph };

type Impact = Awaited<ReturnType<typeof compareProposalImpact>>;

function hunkFor(edge: Impact['added'][number], change: 'added' | 'removed', hunks: Hunk[], symbols: SymbolEntry[]): Hunk | undefined {
  const inFile = hunks.filter(h => h.path === edge.path);
  if (edge.symbol === '<module>') {
    const sign = change === 'added' ? '+' : '-';
    return inFile.find(h => h.lines.some(l => l.startsWith(sign)));
  }
  const symbol = symbols.find(s => s.path === edge.path && s.qualifiedName === edge.symbol);
  if (!symbol) return undefined;
  return inFile.find(h => {
    const start = change === 'added' ? h.newStart : h.oldStart;
    const end = start + (change === 'added' ? h.newLines : h.oldLines) - 1;
    return start <= symbol.endLine && end >= symbol.startLine;
  });
}

export function buildWiring(impact: Impact, proposal: Proposal, candidateSymbols: SymbolEntry[], baseSymbols: SymbolEntry[] = []): WiringGraph {
  const nodes = new Map<string, WiringGraph['nodes'][number]>();
  const edges: WiringGraph['edges'] = [];
  const symbolLine = (path: string, symbol: string) => [...candidateSymbols, ...baseSymbols].find(s => s.path === path && s.qualifiedName === symbol)?.startLine;
  for (const [change, list, symbols] of [['added', impact.added, candidateSymbols], ['removed', impact.removed, baseSymbols]] as const) {
    for (const edge of list) {
      const hunk = hunkFor(edge, change, proposal.hunks, symbols);
      const from = edge.path + '#' + edge.symbol;
      if (!nodes.has(from)) nodes.set(from, { id: from, label: edge.symbol === '<module>' ? edge.path : edge.symbol, path: edge.path, line: symbolLine(edge.path, edge.symbol) });
      if (!nodes.has(edge.target)) nodes.set(edge.target, { id: edge.target, label: edge.target, path: edge.definition?.path ?? '', line: edge.definition?.line });
      edges.push({
        id: `${change}:${edge.kind}:${from}>${edge.target}`, from, to: edge.target, change, kind: edge.kind,
        hunkId: hunk?.id, hunkLine: hunk?.newStart,
      });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

export async function wiringFor(proposal: Proposal, workspaceSymbols: SymbolEntry[], wasmDir?: string): Promise<WiringGraph> {
  const all = structuredClone(proposal);
  for (const h of all.hunks) h.decision = 'accepted';
  const impact = await compareProposalImpact(all, workspaceSymbols, wasmDir);
  const parser = await loadParser(wasmDir);
  try {
    const py = all.files.filter(f => f.path.endsWith('.py'));
    return buildWiring(
      impact, all,
      py.flatMap(f => parsePython(parser, f.path, rebuildFile(f.base, f.path, all.hunks))),
      py.flatMap(f => parsePython(parser, f.path, f.base)),
    );
  } finally { parser.delete(); }
}
