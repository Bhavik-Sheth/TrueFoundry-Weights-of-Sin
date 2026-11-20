/**
 * run/failureMode.ts - "Test resilience" toggle logic (no vscode, no SDK; deps injected so tests can fake them).
 *
 * simulate(): creates the broken custom provider "contexo-broken" in TrueForge, re-registers the PRIMARY agent on
 * it and remembers the mode. restore(): re-registers the primary on contexo.primaryModel, deletes the broken
 * provider and clears the mode. The fallback agent is never touched. No model provider is contacted by Contexo.
 *
 * Exports: FailureSim, createFailureSim, expectedPrimaryModel.
 * Depends on: run/manifests (type-only use of the admin shape). Depended on by: shell/setupController, tests.
 */
import { brokenModelFqn } from './manifests';

export interface FailureSimDeps {
  admin: {
    ensureBrokenProvider(): Promise<void>;
    deleteBrokenProvider(): Promise<void>;
    ensureAgent(kind: 'primary' | 'fallback', model: string, instructions: string): Promise<unknown>;
  };
  /** Persistent flag (globalState). */
  store: { get(): boolean; set(v: boolean): void | Thenable<void> };
  primaryModel: () => string;
  instructions: string;
}

type Thenable<T> = PromiseLike<T>;

export interface FailureSim {
  readonly active: boolean;
  simulate(): Promise<void>;
  restore(): Promise<void>;
}

/** The model the primary agent is expected to use right now (the broken one while simulating). */
export function expectedPrimaryModel(simulating: boolean, primaryModel: string): string {
  return simulating ? brokenModelFqn() : primaryModel;
}

export function createFailureSim(deps: FailureSimDeps): FailureSim {
  return {
    get active() { return deps.store.get(); },

    async simulate() {
      await deps.admin.ensureBrokenProvider();
      await deps.admin.ensureAgent('primary', brokenModelFqn(), deps.instructions);
      await deps.store.set(true);
    },

    async restore() {
      const primary = deps.primaryModel();
      if (!primary) throw new Error('Choose a primary model first (Settings -> Choose models), then restore.');
      await deps.admin.ensureAgent('primary', primary, deps.instructions);
      await deps.admin.deleteBrokenProvider();
      await deps.store.set(false);
    },
  };
}
