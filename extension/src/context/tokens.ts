/**
 * context/tokens.ts - C3 token estimation.
 *
 * Exports:
 *  - count(text): number - ESTIMATE. S0 uses Math.ceil(length / 4); Slice 5 may swap in js-tiktoken
 *    cl100k_base cached by content hash. Values are displayed with "~" in the UI.
 *
 * Rules: pure (no vscode import).
 * Depends on: nothing. Depended on by: context/assembler.
 */
export function count(text: string): number {
  return Math.ceil(text.length / 4);
}
