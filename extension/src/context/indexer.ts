/**
 * context/indexer.ts - C3 Python symbol and doc index.
 *
 * Exports:
 *  - startIndexing(): walks *.py, *.rst, *.md (via ripgrep --files, honouring .gitignore); parses
 *    Python with web-tree-sitter (grammars/tree-sitter-python.wasm) into SymbolEntry (classes,
 *    functions, methods, tests, decorators, calls, imports); splits docs into heading sections.
 *    Works in chunks with setImmediate yields so the host never blocks (target < 10 s for Flask).
 *  - reindexFile(path): refresh on save only.
 *  - API: symbols(), byName(name), inFile(path), enclosing(path, line), ready: Promise<void>.
 *
 * Rules: search must work before the index is ready (ripgrep only).
 * Depends on: web-tree-sitter, @vscode/ripgrep, types. Depended on by: context/search,
 * context/assembler, review/guards, mcp/tools.
 */
export {};
