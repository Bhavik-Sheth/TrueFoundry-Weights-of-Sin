/**
 * config.ts - typed getters for contexo.* settings (C1).
 *
 * Exports:
 *  - ContexoConfig, getConfig(): read-only wrapper over vscode.workspace.getConfiguration('contexo')
 *    with the PRD_Lite 9.6 defaults plus mcpPort (8791) and devMode (false).
 *
 * Rules: no model/provider settings may ever live here (models are configured in TrueForge only).
 * Depends on: vscode API only.
 * Depended on by: extension, run/tfClient, run/runManager, mcp/runCommand, context/assembler.
 */
import * as vscode from 'vscode';

export interface ContexoConfig {
  trueforgeUrl: string;
  primaryAgent: string;
  fallbackAgent: string;
  excerptBudget: number;
  firstEventTimeoutMs: number;
  commandAllowlist: string[];
  mcpPort: number;
  devMode: boolean;
  autoStartTrueForge: boolean;
  /** 'provider/model' names chosen in the setup wizard (strings only, never keys). */
  primaryModel: string;
  fallbackModel: string;
}

export function getConfig(): ContexoConfig {
  const c = vscode.workspace.getConfiguration('contexo');
  return {
    trueforgeUrl: c.get<string>('trueforgeUrl', 'http://localhost:8790'),
    primaryAgent: c.get<string>('primaryAgent', 'contexo'),
    fallbackAgent: c.get<string>('fallbackAgent', 'contexo-fallback'),
    excerptBudget: c.get<number>('excerptBudget', 8000),
    firstEventTimeoutMs: c.get<number>('firstEventTimeoutMs', 20000),
    commandAllowlist: c.get<string[]>('commandAllowlist', ['python', 'pytest', 'flask']),
    mcpPort: c.get<number>('mcpPort', 8791),
    devMode: c.get<boolean>('devMode', false),
    autoStartTrueForge: c.get<boolean>('autoStartTrueForge', true),
    primaryModel: c.get<string>('primaryModel', ''),
    fallbackModel: c.get<string>('fallbackModel', ''),
  };
}
