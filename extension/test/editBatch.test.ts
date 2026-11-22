import { describe, expect, it } from 'vitest';
import { buildProposalFiles } from '../src/review/editBatch';
import { sha256 } from '../src/review/proposal';

const base = 'def f():\n    return 1\n\n\ndef g():\n    pass\n';

async function edit(newText: string) {
  const [file] = await buildProposalFiles(
    [{ path: 'a.py', baseHash: sha256(base), startLine: 1, endLine: 3, newText }],
    async () => base,
  );
  return file.proposed;
}

describe('range edits', () => {
  it('keeps blank separator lines the replacement omitted', async () => {
    expect(await edit('def f():\n    return 2\n')).toBe('def f():\n    return 2\n\n\ndef g():\n    pass\n');
  });

  it('does not add blank lines the replacement already kept', async () => {
    expect(await edit('def f():\n    return 2\n\n')).toBe('def f():\n    return 2\n\n\ndef g():\n    pass\n');
  });
});
