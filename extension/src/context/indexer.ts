/**
 * context/indexer.ts - C3 Python symbol and doc index.
 *
 * Exports:
 *  - IndexApi: ready, symbols(), byName(name), inFile(path), enclosing(path, line), reindexFile(path), reindexAll().
 *  - startIndexing(): S0 STUB - empty index, ready resolved. Slice 2 walks *.py, *.rst, *.md (ripgrep --files,
 *    honouring .gitignore), parses Python with web-tree-sitter (grammars/tree-sitter-python.wasm) into
 *    SymbolEntry, splits docs into heading sections, works in chunks with setImmediate yields.
 *
 * Rules: search must work before the index is ready (ripgrep only).
 * Depends on: web-tree-sitter, @vscode/ripgrep, types, log. Depended on by: context/search,
 * context/assembler, review/guards, mcp/tools.
 */
import type { SymbolEntry } from '../types';
import { log } from '../log';

export interface IndexApi {
  ready: Promise<void>;
  symbols(): SymbolEntry[];
  byName(n: string): SymbolEntry[];
  inFile(p: string): SymbolEntry[];
  enclosing(p: string, line: number): SymbolEntry | undefined;
  reindexFile(p: string): Promise<void>;
  reindexAll(): Promise<void>;
}

export function startIndexing(): IndexApi {
  log('[stub] startIndexing');
  return {
    ready: Promise.resolve(),
    symbols: () => [],
    byName: () => [],
    inFile: () => [],
    enclosing: () => undefined,
    reindexFile: async (p: string) => { log('[stub] reindexFile', p); },
    reindexAll: async () => { log('[stub] reindexAll'); },
  };
}
