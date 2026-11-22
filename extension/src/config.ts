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
import { inceptionModel } from './run/inception';
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
  autoRegisterTrueForge: boolean;
  stopTrueForgeOnExit: 'startedByContexo' | 'always' | 'never';
  /** 'provider/model' names chosen in the setup wizard (strings only, never keys). */
  primaryModel: string;
  fallbackModel: string;
  historyMinLines: number;
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
    autoRegisterTrueForge: c.get<boolean>('autoRegisterTrueForge', true),
    stopTrueForgeOnExit: c.get<'startedByContexo' | 'always' | 'never'>('stopTrueForgeOnExit', 'startedByContexo'),
    primaryModel: c.get<string>('primaryModel', inceptionModel),
    fallbackModel: c.get<string>('fallbackModel', ''),
    historyMinLines: c.get<number>('history.minLines', 3),
  };
}
