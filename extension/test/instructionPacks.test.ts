import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadPacks, parsePack } from '../src/context/instructionPacks';
import { count } from '../src/context/tokens';

const TEXT = '---\nname: pytest-testing\nversion: 1\nwhen: writing tests\n---\nBody line.\n';

describe('instruction packs', () => {
  it('parses front matter', () => expect(parsePack('pytest-testing@1.md', TEXT)).toMatchObject({ name: 'pytest-testing', version: 1, when: 'writing tests', body: 'Body line.' }));
  it('rejects name/version mismatch', () => {
    expect(() => parsePack('pytest-testing@2.md', TEXT)).toThrow(/PACK_INVALID/);
    expect(() => parsePack('other@1.md', TEXT)).toThrow(/PACK_INVALID/);
    expect(() => parsePack('pytest-testing@1.md', 'no front matter')).toThrow(/PACK_INVALID/);
  });
  it('shipped packs load and fit budget', async () => {
    const packs = await loadPacks(path.join(__dirname, '..', 'instruction-packs'));
    expect(packs.map(p => p.name).sort()).toEqual(['pytest-testing', 'python-editing', 'rst-docs']);
    for (const p of packs) expect(count(p.body)).toBeLessThanOrEqual(1500);
    const py = packs.find(p => p.name === 'pytest-testing')!.body;
    expect(py).toMatch(/CliRunner/);
    expect(py).toMatch(/test_cli_runner/);
    expect(py).toMatch(/-q/);
  });
});
