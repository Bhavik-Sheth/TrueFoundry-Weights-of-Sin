# grammars

Place `tree-sitter-python.wasm` in this folder (binary, not committed by the scaffold).

## Where to get it
- The tree-sitter-python release assets, or
- The `tree-sitter-python` npm package (prebuilt wasm), or build with `tree-sitter build --wasm`.
Use a build compatible with the pinned `web-tree-sitter` version.

## Who loads it
- `src/context/indexer.ts` (symbol/call/decorator/import extraction)
- `src/review/guards.ts` (symbol check on proposed files)
