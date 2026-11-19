/**
 * vite.config.ts - builds the React webview (webview/) into dist/webview (C1).
 *
 * Will: root = webview/, @vitejs/plugin-react, build.outDir = ../dist/webview, stable
 * (hash-less) asset names so panel.ts can reference them, no inline scripts (CSP nonce).
 * Depends on: vite, webview/index.html. Depended on by: npm run build.
 */
export {};
