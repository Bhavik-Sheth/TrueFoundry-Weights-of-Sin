/**
 * shell/setup.ts - pure setup-state logic (no vscode).
 *
 * Exports:
 *  - computeSetupStatus(i): builds a SetupStatus from raw facts.
 *  - isSetupComplete(s): TrueForge running, >=1 model, primary chosen (and available), connector + agents registered.
 * Depends on: types. Depended on by: shell/setupController, tests.
 */
import type { SetupStatus } from '../types';

export interface SetupInputs {
  trueforge: SetupStatus['trueforge'];
  detail?: string;
  providersConfigured: string[];
  models: string[];
  primaryModel?: string;
  fallbackModel?: string;
  connectorOk: boolean;
  agentsOk: boolean;
  mcpOk: boolean;
  indexReady: boolean;
}

export function computeSetupStatus(i: SetupInputs): SetupStatus {
  const running = i.trueforge === 'running';
  return {
    trueforge: i.trueforge,
    detail: i.detail,
    providersConfigured: running ? i.providersConfigured : [],
    models: running ? i.models : [],
    primaryModel: i.primaryModel || undefined,
    fallbackModel: i.fallbackModel || undefined,
    connectorOk: running && i.connectorOk,
    agentsOk: running && i.agentsOk,
    mcpOk: i.mcpOk,
    indexReady: i.indexReady,
  };
}

export function isSetupComplete(s: SetupStatus): boolean {
  return (
    s.trueforge === 'running' &&
    s.models.length > 0 &&
    !!s.primaryModel &&
    s.models.includes(s.primaryModel) &&
    s.connectorOk &&
    s.agentsOk
  );
}
