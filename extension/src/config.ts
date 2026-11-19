/**
 * config.ts - typed getters for contexo.* settings (C1).
 *
 * Exports:
 *  - getConfig(): { trueforgeUrl, primaryAgent, fallbackAgent, excerptBudget,
 *    firstEventTimeoutMs, commandAllowlist } with defaults from PRD_Lite 9.6.
 *  - onConfigChange(cb): subscribe to configuration changes.
 *
 * Rules: read-only wrapper over vscode.workspace.getConfiguration('contexo'); no model/provider
 * settings may ever live here (models are configured in TrueForge only).
 * Depends on: vscode API only.
 * Depended on by: extension, run/tfClient, run/runManager, mcp/runCommand, context/assembler.
 */
export {};
