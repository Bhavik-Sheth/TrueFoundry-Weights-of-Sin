/**
 * esbuild.mjs - build script for the extension host bundle (C1).
 *
 * Bundles src/extension.ts to dist/extension.js (platform node, format cjs, target node18,
 * external vscode, sourcemap). Supports --watch. Copies web-tree-sitter's runtime wasm and the
 * python grammar wasm (from the tree-sitter-python npm package) into dist/. Ripgrep is NOT bundled: the extension
 * uses VS Code's own rg binary.
 * Depends on: esbuild, package.json scripts. Depended on by: npm run build/watch.
 */
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

function copyWasm() {
  mkdirSync('dist', { recursive: true });
  const wtsDir = path.join(root, 'node_modules', 'web-tree-sitter');
  const runtime = ['web-tree-sitter.wasm', 'tree-sitter.wasm'].map((f) => path.join(wtsDir, f)).find(existsSync);
  if (!runtime) throw new Error('web-tree-sitter runtime wasm not found in ' + wtsDir);
  copyFileSync(runtime, path.join('dist', path.basename(runtime)));
  const pyDir = path.join(root, 'node_modules', 'tree-sitter-python');
  copyFileSync(path.join(pyDir, 'tree-sitter-python.wasm'), path.join('dist', 'tree-sitter-python.wasm'));
}

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

copyWasm();
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching');
} else {
  await build(options);
}
