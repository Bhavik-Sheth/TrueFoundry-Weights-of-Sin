/**
 * ChatTab.tsx - Chat tab (C1).
 *
 * Exports:
 *  - ChatTab (React component): mounts TrueForgeUI from @truefoundry/trueforge-ui bound to the
 *    sessionId received in the session message (connect-src to TrueForge URL allowed by CSP).
 *  - Fallback renderer (only if the hour-1 spike shows TrueForge UI cannot attach to an existing
 *    session in a webview): renders host-relayed events itself (merged model.message text,
 *    tool-call chips, approval chips, ~150 lines).
 *
 * Depends on: bridge.ts, @truefoundry/trueforge-ui. Depended on by: App.tsx.
 */
export {};
