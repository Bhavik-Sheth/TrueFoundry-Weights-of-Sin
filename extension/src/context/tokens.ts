/**
 * context/tokens.ts - C3 token estimation.
 *
 * Exports:
 *  - count(text): number - ESTIMATE using js-tiktoken cl100k_base (not the TrueForge model's tokenizer), cached by
 *    content hash. Values are displayed with "~" in the UI. Falls back to ceil(length / 4) if the encoder fails.
 *
 * Rules: pure (no vscode import).
 * Depends on: js-tiktoken, node:crypto. Depended on by: context/assembler.
 */
import { createHash } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';

let enc: Tiktoken | undefined;
let encFailed = false;
const cache = new Map<string, number>();

export function count(text: string): number {
  const key = createHash('sha256').update(text, 'utf8').digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let n: number;
  try {
    if (!enc && !encFailed) enc = getEncoding('cl100k_base');
    n = enc ? enc.encode(text).length : Math.ceil(text.length / 4);
  } catch {
    encFailed = true;
    n = Math.ceil(text.length / 4);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, n);
  return n;
}
