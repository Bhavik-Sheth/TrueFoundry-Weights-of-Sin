/**
 * esbuild.mjs - build script for the extension host bundle (C1).
 *
 * Will: bundle src/extension.ts to dist/extension.js (platform node, format cjs, external
 * vscode), support --watch and --production flags, sourcemaps in dev, and copy the
 * tree-sitter wasm files (grammars/ and web-tree-sitter) plus ripgrep binary into dist/ as needed.
 * Depends on: esbuild, package.json scripts. Depended on by: npm run build/watch.
 */
