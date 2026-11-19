/**
 * mcp/server.ts - C3 MCP Streamable HTTP server for TrueForge.
 *
 * Exports:
 *  - startServer(): Promise<{ port, token, revoke, stop }> - binds 127.0.0.1 on a random port.
 *  - revoke(runId): reject all later calls for that run (used by Stop).
 *  - resolveInWorkspace(p): path guard (no "..", no absolute paths, no .git/).
 *  - capOutput(text): cap tool output at 16k characters.
 *
 * Rules: every request must carry X-Contexo-Token; registers tools from mcp/tools.
 * Depends on: @modelcontextprotocol/sdk, mcp/tools. Depended on by: extension, run/runManager.
 */
export {};
