/**
 * vite.config.ts - builds the React webview (webview/) into dist/webview (C1).
 *
 * root = webview/, @vitejs/plugin-react, build.outDir = ../dist/webview, fixed (hash-less)
 * names index.js / index.css so shell/panel.ts can reference them. panel.ts supplies its own
 * HTML (CSP + nonce), so webview/index.html is only the build entry.
 * Depends on: vite, webview/index.html. Depended on by: npm run build.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'webview',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'index.js',
        chunkFileNames: 'index-[name].js',
        assetFileNames: (a) => ((a.names ?? []).some((n) => n.endsWith('.css')) ? 'index.css' : '[name][extname]'),
      },
    },
  },
});
