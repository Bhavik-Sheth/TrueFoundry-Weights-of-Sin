/**
 * review/guards.ts - C4 symbol check and scope guard.
 *
 * Exports:
 *  - symbolCheck(files, index): Promise<Violation[]> where violation = MISSING_SYMBOL name @ path:line.
 *    Parses proposed files with Tree-sitter; collects bare-name calls and decorator names on '+' lines.
 *    A name passes if defined/imported in the proposed file (incl. defs added in the proposal), a
 *    Python builtin, known in the workspace index and importable, or a parameter/local of the
 *    enclosing function. Names possibly from star imports are unknown-but-allowed. Dynamic
 *    attributes (x.foo) are skipped.
 *  - scopeGuard(hunks, selection): sets outsideSelection by mapping each hunk's old range against
 *    the selection range adjusted by line deltas of hunks above it. Accept stays available.
 *  - PYTHON_BUILTINS: builtin name set.
 *
 * Rules: lexical/structural only; avoid false denials.
 * Loads grammars/tree-sitter-python.wasm.
 * Depends on: context/indexer, web-tree-sitter, types. Depended on by: review/diffView.
 */
export {};
