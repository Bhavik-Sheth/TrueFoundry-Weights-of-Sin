/**
 * context/instructionPacks.ts - versioned how-to guides the agent loads on demand (get_instruction_pack).
 *
 * Exports:
 *  - Pack { name, version, when, body }.
 *  - parsePack(file, text): Pack - file is `<name>@<version>.md`; front matter `---\nname\nversion\nwhen\n---`.
 *    name/version must match the file name or it throws `PACK_INVALID <file>`.
 *  - loadPacks(dir): Promise<Pack[]> - every `*.md` in dir, sorted by name.
 *  - cachedPacks(dir): Promise<Pack[]> - loadPacks memoized per directory.
 *
 * Rules: pure (no vscode import).
 * Depends on: node:fs/promises, node:path. Depended on by: mcp/tools.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Pack { name: string; version: number; when: string; body: string }

export function parsePack(file: string, text: string): Pack {
  const bad = new Error(`PACK_INVALID ${file}`);
  const m = /^(.+)@(\d+)\.md$/.exec(file);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m || !fm) throw bad;
  const fields = new Map<string, string>();
  for (const line of fm[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const name = fields.get('name');
  const when = fields.get('when');
  if (name !== m[1] || Number(fields.get('version')) !== Number(m[2]) || !when) throw bad;
  return { name, version: Number(m[2]), when, body: fm[2].trim() };
}

export async function loadPacks(dir: string): Promise<Pack[]> {
  const files = (await readdir(dir)).filter(f => f.endsWith('.md')).sort();
  const packs = await Promise.all(files.map(async f => parsePack(f, await readFile(path.join(dir, f), 'utf8'))));
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

const cache = new Map<string, Promise<Pack[]>>();
export function cachedPacks(dir: string): Promise<Pack[]> {
  let p = cache.get(dir);
  if (!p) {
    p = loadPacks(dir);
    p.catch(() => cache.delete(dir));
    cache.set(dir, p);
  }
  return p;
}
