/**
 * App.tsx - webview shell (C1).
 *
 * Exports:
 *  - App (React component): tabs Chat / Context / Changes (selected tab persisted with
 *    vscode.setState); run header with Stop button and "Open session in TrueForge" link;
 *    amber fallback banner from runState.banner; subscribes to bridge messages
 *    (session, runState, packet, changes) and sends ready on mount.
 *
 * Depends on: bridge.ts, ChatTab.tsx, ContextTab.tsx, ChangesTab.tsx. Depended on by: main.tsx.
 */
export {};
