import { z } from 'zod';
import { applyEditExact, sha256 } from './proposal';
import type { FileEdit, Proposal } from '../types';

export const EDIT_MAX_LINES = 24;
export const EDIT_MAX_CHARACTERS = 4000;

export const proposalInput = z.object({
  summary: z.string().min(1),
  edits: z.array(z.object({
    path: z.string().min(1).describe('Workspace-relative file'),
    baseHash: z.string().min(1).describe('Full current file hash from read_file, or "new" for legacy file creation'),
    startLine: z.number().int().positive().optional().describe('First line of an exact current range from read_file'),
    endLine: z.number().int().positive().optional().describe('Last line inclusive. Replace at most 24 lines per range.'),
    oldText: z.string().optional().describe('Exact old text for legacy edits. Omit when supplying line numbers.'),
    newText: z.string().describe('Replacement only. Keep a range replacement within 4,000 characters.'),
  })).min(1),
  requirements: z.array(z.string()).max(12).optional().describe('Requirement ids (R1…) or texts this change satisfies'),
  acknowledgedHistory: z.array(z.object({ commit: z.string().min(7), reason: z.string().min(1) })).optional()
    .describe('Commits from HISTORY_CONCERN you checked, with how your change preserves their intent'),
});

export const splitSourceLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function applyRanges(base: string, edits: FileEdit[]) {
  const lines = splitSourceLines(base);
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const ranges = edits.map(edit => {
    const { startLine: first, endLine: last, newText } = edit;
    if (edit.oldText !== undefined || edit.baseHash === 'new' || first === undefined || last === undefined ||
        !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || first > last ||
        last > lines.length || last - first + 1 > EDIT_MAX_LINES || newText.length > EDIT_MAX_CHARACTERS) {
      throw new Error('INVALID_RANGE: use an existing range of up to 24 lines and up to 4,000 replacement characters.');
    }
    const old = lines.slice(first - 1, last).join('');
    if (old.length > EDIT_MAX_CHARACTERS) throw new Error('INVALID_RANGE: read and edit a smaller source range.');
    let replacement = newText.replace(/\r?\n/g, eol);
    if (replacement && old.endsWith('\n') && !replacement.endsWith('\n')) replacement += eol;
    if (replacement === old) throw new Error('NO_CHANGE: the supplied range replacement matches the current source.');
    return { first, last, replacement };
  }).sort((a, b) => b.first - a.first);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].last >= ranges[i - 1].first) throw new Error('OVERLAPPING_RANGES: ranges must be disjoint in the base file.');
  }
  for (const { first, last, replacement } of ranges) lines.splice(first - 1, last - first + 1, replacement);
  return lines.join('');
}

export async function buildProposalFiles(edits: FileEdit[], read: (path: string) => Promise<string | undefined>): Promise<Proposal['files']> {
  const byPath = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    const list = byPath.get(edit.path) ?? [];
    list.push(edit);
    byPath.set(edit.path, list);
  }
  const files: Proposal['files'] = [];
  for (const [path, group] of byPath) {
    try {
      const current = await read(path);
      const base = current ?? '';
      const baseHash = current === undefined ? 'new' : sha256(base);
      const first = group[0];
      if (current !== undefined && first.baseHash === 'new') throw new Error('FILE_EXISTS: read the current file before editing.');
      if (current === undefined && first.baseHash !== 'new') throw new Error('FILE_NOT_FOUND: use the file creation form for a new file.');
      if (group.some(edit => edit.baseHash !== baseHash)) throw new Error('STALE_BASE: reread the file and use the same current hash for all edits.');
      const ranged = group.some(edit => edit.startLine !== undefined || edit.endLine !== undefined);
      const proposed = ranged ? applyRanges(base, group) : group.reduce((text, edit) => {
        if (typeof edit.oldText !== 'string') throw new Error('INVALID_ARGS: supply an exact range or legacy oldText.');
        return applyEditExact(text, edit.oldText, edit.newText);
      }, base);
      if (proposed !== base) files.push({ path, base, proposed, baseHash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} (${path})`, { cause: error });
    }
  }
  return files;
}
