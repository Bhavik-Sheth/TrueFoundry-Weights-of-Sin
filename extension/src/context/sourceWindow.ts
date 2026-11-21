import { EDIT_MAX_LINES, EDIT_MAX_CHARACTERS, splitSourceLines } from '../review/editBatch';
import { sha256 } from '../review/proposal';

const MAX_SOURCE_CHARACTERS = 16_000;
const MAX_SERIALIZED_CHARACTERS = 20_000;

/** Preserve the exact line endings and bind the read to the full current file. */
export function sourceWindow(path: string, source: string, startLine = 1, endLine?: number) {
  if (endLine !== undefined && endLine < startLine) throw new Error('endLine must be at least startLine.');
  const lines = splitSourceLines(source);
  const selected = startLine === 1 && endLine === undefined
    ? source : lines.slice(startLine - 1, endLine).join('');
  const last = Math.min(endLine ?? lines.length, lines.length);
  const result = { path, hash: sha256(source), totalLines: lines.length, startLine, endLine: last,
    text: '', truncated: false, rangeWritable: false };
  let length = Math.min(MAX_SOURCE_CHARACTERS, selected.length);
  // The envelope contains a JSON string inside MCP text. Count both levels of escaping.
  for (;;) {
    result.text = selected.slice(0, length);
    result.truncated = length < selected.length;
    result.rangeWritable = !result.truncated && endLine !== undefined && endLine === last &&
      last >= startLine && last - startLine + 1 <= EDIT_MAX_LINES && length <= EDIT_MAX_CHARACTERS;
    if (JSON.stringify(JSON.stringify(result)).length <= MAX_SERIALIZED_CHARACTERS) return result;
    if (length === 0) throw new Error('Source path exceeds the transport budget.');
    length = Math.floor(length * 0.75);
  }
}
