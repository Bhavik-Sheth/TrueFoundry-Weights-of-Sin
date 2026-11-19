/**
 * extension.ts - extension entry point (C1 Editor Shell & Panel; wires all components).
 *
 * Exports:
 *  - activate(context): load config; start the MCP server (mcp/server) on 127.0.0.1 random port;
 *    generate a random token; write port + token into copies of trueforge/*.agent.json under the
 *    extension's global storage (never into the repo); start async indexing (context/indexer);
 *    create RunManager; register the webview panel, commands (contexo.inlineEdit, contexo.stop,
 *    contexo.undoHunk, contexo.redoHunk), content providers (contexo-base / contexo-proposed),
 *    CodeLens provider, and the status bar.
 *  - deactivate(): stop the MCP server, cancel the active run, kill run_command children.
 *
 * Rules: activation must not block the host (indexing is chunked/async).
 * Depends on: config, types, shell/*, run/*, mcp/*, context/*, review/*.
 * Depended on by: VS Code (package.json "main" via dist/extension.js).
 */
export {};
