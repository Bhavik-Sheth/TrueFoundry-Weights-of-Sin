/**
 * context/tokens.ts - C3 token estimation.
 *
 * Exports:
 *  - count(text): number - ESTIMATE using js-tiktoken cl100k_base (not the TrueForge model's tokenizer), cached by
 *    content hash. Values are displayed with "~" in the UI. Falls back to UTF-8 bytes as a conservative estimate if encoding fails.
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
  if (!enc && !encFailed) {
    try {
      enc = getEncoding('cl100k_base');
    } catch {
      encFailed = true;
    }
  }
  let n: number;
  try {
    // Repository text may contain literal tokenizer markers. Treat them as source.
    n = enc ? enc.encode(text, [], []).length : Buffer.byteLength(text, 'utf8');
  } catch {
    n = Buffer.byteLength(text, 'utf8');
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, n);
  return n;
}

/** Keep inline source small without changing the selection's underlying range or hash. */
export function previewSelection(text: string): { text: string; truncated: boolean } {
  const maxCharacters = 6000;
  const maxTokens = 1600;
  if (text.length <= maxCharacters && count(text) <= maxTokens) return { text, truncated: false };
  let prefix = text.slice(0, maxCharacters);
  while (count(prefix) > maxTokens) prefix = prefix.slice(0, Math.floor(prefix.length / 2));
  const newline = prefix.lastIndexOf('\n');
  if (newline >= prefix.length / 2) prefix = prefix.slice(0, newline);
  return { text: prefix.replace(/[\uD800-\uDBFF]$/, ''), truncated: true };
}
