/**
 * summary.ts - review summary facts.
 *
 * Exports:
 *  - SummaryFact: one sentence about a proposal, with the hunks (and optionally the check) that back it.
 *
 * Must not import 'vscode'. Depended on by: src/types.ts.
 */
export interface SummaryFact { text: string; hunkIds: string[]; checkId?: string }
