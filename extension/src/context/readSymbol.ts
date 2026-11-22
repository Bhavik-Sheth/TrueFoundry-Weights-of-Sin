/**
 * readSymbol.ts - resolve a symbol name to one indexed Python function/class for the read_symbol tool.
 *
 * Exports: resolveSymbol(index, name) -> { symbol } | { candidates (<=10, index order) } | { error: 'NOT_FOUND' }.
 * Order: exact qualifiedName, module-qualified (moduleOf(path).qualifiedName), unique byName, unique
 * '.'+name suffix of qualifiedName; several matches at a step return candidates. Doc symbols are excluded.
 * Depends on: indexer (IndexApi type), review/impactGraph (moduleOf), types. Depended on by: mcp/tools.
 */
import type { IndexApi } from './indexer';
import { moduleOf } from '../review/impactGraph';
import type { SymbolEntry } from '../types';

export type ResolvedSymbol =
  | { symbol: SymbolEntry }
  | { candidates: Array<{ qualifiedName: string; path: string; line: number }> }
  | { error: 'NOT_FOUND' };

export function resolveSymbol(index: IndexApi, name: string): ResolvedSymbol {
  const code = index.symbols().filter((s) => s.kind !== 'doc');
  const steps: SymbolEntry[][] = [
    code.filter((s) => s.qualifiedName === name),
    code.filter((s) => moduleOf(s.path) + '.' + s.qualifiedName === name),
    index.byName(name).filter((s) => s.kind !== 'doc'),
    code.filter((s) => ('.' + s.qualifiedName).endsWith('.' + name)),
  ];
  for (const found of steps) {
    if (found.length === 1) return { symbol: found[0] };
    if (found.length > 1) {
      return { candidates: found.slice(0, 10).map((s) => ({ qualifiedName: s.qualifiedName, path: s.path, line: s.startLine })) };
    }
  }
  return { error: 'NOT_FOUND' };
}
