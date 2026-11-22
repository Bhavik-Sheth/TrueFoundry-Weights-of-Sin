/**
 * review/regenerate.ts - prompt for the Regenerate button shown after a stale review.
 *
 * Exports:
 *  - regeneratePrompt(path, summary?): message sent to the agent asking it to re-read the file and
 *    propose the same change against the current text.
 */
export function regeneratePrompt(path: string, summary?: string): string {
  return `The file \`${path}\` changed while your proposal${summary ? ` ("${summary}")` : ''} was under review, so nothing was written. Re-read \`${path}\` with read_file and propose the same change again against the current text.`;
}
