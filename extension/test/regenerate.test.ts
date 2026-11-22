/**
 * regenerate.test.ts - tests for src/review/regenerate.ts (stale-review Regenerate prompt).
 */
import { describe, expect, it } from 'vitest';
import { regeneratePrompt } from '../src/review/regenerate';

describe('regeneratePrompt', () => {
  it('includes the summary when given', () => {
    expect(regeneratePrompt('src/flask/helpers.py', 'Treat off and n as false')).toBe(
      'The file `src/flask/helpers.py` changed while your proposal ("Treat off and n as false") was under review, so nothing was written. Re-read `src/flask/helpers.py` with read_file and propose the same change again against the current text.');
  });
  it('omits the summary clause when absent', () => {
    expect(regeneratePrompt('src/flask/helpers.py')).toBe(
      'The file `src/flask/helpers.py` changed while your proposal was under review, so nothing was written. Re-read `src/flask/helpers.py` with read_file and propose the same change again against the current text.');
  });
});
