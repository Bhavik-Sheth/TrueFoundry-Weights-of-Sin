/**
 * context/search.ts - C3 lexical retrieval primitives.
 *
 * Exports:
 *  - tokenize(text): identifier tokenizer with snake_case/camelCase splitting and stopword removal.
 *  - class Bm25 / bm25Rank(query, docs): small BM25 over symbol entries and doc sections.
 *  - symbolNameMatch(terms): ranked symbol-name matches.
 *  - ripgrepSearch(term, opts): rg --json per term, max hits, maps hits to enclosing symbols.
 *
 * Depends on: context/indexer, @vscode/ripgrep. Depended on by: context/assembler, mcp/tools.
 */
export {};
