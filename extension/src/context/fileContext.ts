import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { structuredPatch } from 'diff';
import { z } from 'zod';
import type { ContextPacket, FileChange, FileContext, Reason } from '../types';
import { assertNativeWorkspacePath, resolveUnder } from '../mcp/server';
import type { IndexApi } from './indexer';
import { workspaceGitEnv } from '../shell/workspaceGitEnv';

const exec = promisify(execFile);
const maxSourceBytes = 256 * 1024;
const automaticFileLimit = 8;

export const fileContextInput = {
  path: z.string().min(1).describe('Workspace-relative file path'),
  version: z.enum(['head', 'previous']).optional().describe('Read Git HEAD or the version before the last file change'),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
};
type Source = { status: 'text'; text: string } | { status: 'missing' | 'binary' | 'too_large' | 'unavailable' };
type Snapshot = { commit: string; prefix: string };
type History = NonNullable<FileContext['lastCommit']>;

function git(root: string, args: string[], maxBuffer = 24_000) {
  return exec('git', ['--no-pager', '--literal-pathspecs', ...args], {
    cwd: root, timeout: 2000, maxBuffer, windowsHide: true, env: workspaceGitEnv(),
  }).then(result => result.stdout);
}

function sourceText(text: string): Source {
  if (Buffer.byteLength(text, 'utf8') > maxSourceBytes) return { status: 'too_large' };
  return text.includes('\0') ? { status: 'binary' } : { status: 'text', text };
}

async function readWorkingFile(absolute: string): Promise<Source> {
  try {
    const file = await open(absolute, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { status: 'unavailable' };
      if (stat.size > maxSourceBytes) return { status: 'too_large' };
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) return { status: 'unavailable' };
      return sourceText(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await file.close();
    }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
}

async function snapshot(root: string): Promise<Snapshot | undefined> {
  const result = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => undefined);
  const commit = result?.trim();
  if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) return;
  const prefix = await git(root, ['rev-parse', '--show-prefix']).catch(() => undefined);
  if (prefix !== undefined) return { commit, prefix: prefix.replace(/\r?\n$/, '') };
}

function cachedGit<T>(cache: Map<string, Promise<T>>, key: string, limit: number, read: () => Promise<T>, reusable: (result: T) => boolean) {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const result = read().then(value => {
    if (!reusable(value) && cache.get(key) === result) cache.delete(key);
    return value;
  }, error => {
    if (cache.get(key) === result) cache.delete(key);
    throw error;
  });
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

// Only Git objects at pinned revisions are cached. Open buffers and disk contents are always reread.
const blobCache = new Map<string, Promise<Source>>();
function blob(root: string, commit: string, path: string): Promise<Source> {
  const key = JSON.stringify([root, commit, path]);
  return cachedGit(blobCache, key, 128, () => readBlob(root, commit, path), value => value.status !== 'unavailable');
}

async function readBlob(root: string, commit: string, path: string): Promise<Source> {
  try {
    return sourceText(await git(root, ['cat-file', 'blob', `${commit}:./${path}`], maxSourceBytes));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { status: 'too_large' };
    if (!failure.killed && /does not exist in|exists on disk, but not in/.test(failure.stderr ?? '')) return { status: 'missing' };
    return { status: 'unavailable' };
  }
}

// Cache metadata against the immutable HEAD. Working versions are checked on every request.
const historyCache = new Map<string, Promise<History | undefined>>();

function lastChange(root: string, head: Snapshot, path: string) {
  const key = JSON.stringify([root, head.commit, path]);
  return cachedGit(historyCache, key, 512, () => git(root, [
    'log', '-1', '--follow', '--no-show-signature', '--format=%H%x00%P%x00%aI%x00%s',
    '--name-status', '-z', head.commit, '--', path,
  ]).then(text => {
    const [commit, parents, date, subject, change, oldPath] = text.split('\0');
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return;
    const parent = parents.split(' ')[0];
    let previousPath: string | undefined = path;
    if (/^R\d+$/.test(change?.trim() ?? '')) {
      previousPath = oldPath?.startsWith(head.prefix) ? oldPath.slice(head.prefix.length) : undefined;
      if (previousPath) resolveUnder(root, previousPath);
    }
    return { commit, date, subject: subject.slice(0, 260), parent: parent || undefined, previousPath };
  }), () => true).catch(() => undefined);
}

function comparable(source: Source): source is { status: 'text'; text: string } | { status: 'missing' } {
  return source.status === 'text' || source.status === 'missing';
}

function compare(path: string, before: Source, after: Source, includeLines: boolean, symbols: FileContext['symbols'] = []): FileChange {
  if (!comparable(before) || !comparable(after)) {
    return { status: 'unavailable', detail: `before=${before.status}; after=${after.status}` };
  }
  if (before.status === 'missing' && after.status === 'missing') return { status: 'missing' };
  const beforeText = before.status === 'text' ? before.text : '';
  const afterText = after.status === 'text' ? after.text : '';
  const status = before.status === 'missing' ? 'added' : after.status === 'missing' ? 'deleted'
    : beforeText === afterText ? 'unchanged' : 'modified';
  if (status === 'unchanged') return { status };
  const diff = structuredPatch(path, path, beforeText, afterText, undefined, undefined, { context: 0, timeout: 35 });
  if (!diff) return { status, detail: 'Change summary exceeded the diff time budget.' };
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    added += hunk.lines.filter(line => line.startsWith('+')).length;
    removed += hunk.lines.filter(line => line.startsWith('-')).length;
  }
  return {
    status, added, removed, hunkCount: diff.hunks.length,
    hunks: diff.hunks.slice(0, includeLines ? 4 : 2).map(hunk => ({
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
      symbols: symbols.filter(symbol => hunk.newLines > 0 && symbol.start <= hunk.newStart + hunk.newLines - 1 &&
        symbol.end >= hunk.newStart).slice(0, 3).map(symbol => symbol.name),
      ...(includeLines ? {
        lines: hunk.lines.slice(0, 8).map(line => line.slice(0, 120)),
        truncated: hunk.lines.length > 8 || hunk.lines.some(line => line.length > 120),
      } : {}),
    })),
  };
}

export function fileContextReader(root: string, index: IndexApi, editorText?: (absolute: string) => string | undefined) {
  let revision: Promise<Snapshot | undefined> | undefined;
  const getHead = () => revision ??= snapshot(root);

  async function describe(path: string, reasons: Reason[] = [], detail = false, includeHistory = detail): Promise<FileContext> {
    const absolute = await assertNativeWorkspacePath(root, path);
    const entries = index.inFile(path);
    const symbols = entries.slice(0, detail ? 24 : 5).map(item => ({
      name: item.qualifiedName.slice(0, 100), kind: item.kind, start: item.startLine, end: item.endLine,
    }));
    const currentBuffer = editorText?.(absolute);
    const [head, working] = await Promise.all([
      getHead(), currentBuffer === undefined ? readWorkingFile(absolute) : sourceText(currentBuffer),
    ]);
    const record: FileContext = {
      path, reasons: reasons.slice(0, 5), symbols, symbolCount: entries.length,
      source: currentBuffer === undefined ? 'working tree' : 'editor buffer',
      workingStatus: working.status,
    };
    if (!entries.length && working.status === 'text') {
      record.openingLines = working.text.split('\n', 24).flatMap((text, position) =>
        text.trim() ? [{ line: position + 1, text: text.trim().slice(0, 100) }] : []).slice(0, 3);
    }
    if (!head) return { ...record, changes: { status: 'unavailable', detail: 'Git HEAD unavailable.' } };
    const [history, committed] = await Promise.all([
      lastChange(root, head, path), blob(root, head.commit, path),
    ]);
    record.head = head.commit;
    record.lastCommit = history;
    record.changes = compare(path, committed, working, includeHistory, currentBuffer === undefined ? symbols : []);
    if (includeHistory && history?.previousPath) {
      const [previous, message] = await Promise.all([
        history.parent ? blob(root, history.parent, history.previousPath) : { status: 'missing' } as const,
        detail ? git(root, ['show', '-s', '--no-show-signature', '--format=%b', history.commit], 8000)
          .then(text => text.trim().slice(0, 1200)).catch(() => undefined) : undefined,
      ]);
      record.previousChanges = compare(path, previous, committed, true);
      if (message) record.lastCommit = { ...history, message };
    }
    return record;
  }

  async function readVersion(path: string, version: 'head' | 'previous', start = 1, end = start + 79) {
    if (end < start) throw new Error('endLine must be at least startLine.');
    await assertNativeWorkspacePath(root, path);
    const head = await getHead();
    const history = head && version === 'previous' ? await lastChange(root, head, path) : undefined;
    const commit = version === 'head' ? head?.commit : history?.parent;
    const file = version === 'head' ? path : history?.previousPath;
    if (!commit || !file) return { path, version, status: 'unavailable' as const };
    const source = await blob(root, commit, file);
    if (source.status !== 'text') return { path, version, commit, historicalPath: file, status: source.status };
    const lines = source.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (start > lines.length) return { path, version, commit, historicalPath: file, status: 'empty_range' as const,
      totalLines: lines.length };
    const last = Math.min(end, start + 199, lines.length);
    const text = lines.slice(start - 1, last).join('');
    return { path, version, commit, historicalPath: file, status: 'text' as const, startLine: start,
      endLine: last, totalLines: lines.length, text: text.slice(0, 3000), truncated: text.length > 3000 || last < Math.min(end, lines.length) };
  }

  async function addToPacket(packet: ContextPacket, mentions: string[] = []): Promise<void> {
    const scoped = new Map<string, Reason[]>();
    for (const excerpt of packet.excerpts) {
      if (scoped.size < automaticFileLimit && excerpt.reasons.some(reason => reason.kind === 'selection')) {
        scoped.set(excerpt.path, [...excerpt.reasons]);
      }
    }
    for (const mention of mentions) {
      const path = mention.replace(/^@/, '').replace(/\\/g, '/').replace(/^\.\//, '');
      if ((!mention.startsWith('@') && !/[/.]/.test(path)) || scoped.size >= automaticFileLimit) continue;
      try {
        resolveUnder(root, path);
        scoped.set(path, [...(scoped.get(path) ?? []), { kind: 'mention', token: mention }]);
      } catch {
        // Non-path mentions will still be handled by symbol retrieval.
      }
    }
    for (const excerpt of packet.excerpts) {
      if (excerpt.priority && scoped.size < automaticFileLimit && !scoped.has(excerpt.path)) scoped.set(excerpt.path, []);
    }
    const implementation = packet.excerpts.find(excerpt => excerpt.category === 'impl');
    const module = implementation && posix.basename(implementation.path, posix.extname(implementation.path));
    for (const category of ['impl', 'test', 'docs'] as const) {
      const candidates = packet.excerpts.filter(excerpt => excerpt.category === category);
      const related = module && candidates.find(excerpt => category === 'docs'
        ? excerpt.path.startsWith('docs/') && posix.basename(excerpt.path, posix.extname(excerpt.path)) === module
        : category === 'test' && posix.basename(excerpt.path) === `test_${module}.py`);
      const excerpt = related || candidates[0];
      if (excerpt && scoped.size < automaticFileLimit && !scoped.has(excerpt.path)) scoped.set(excerpt.path, []);
    }
    for (const excerpt of packet.excerpts) {
      if (!scoped.has(excerpt.path) && scoped.size >= automaticFileLimit) continue;
      const reasons = scoped.get(excerpt.path) ?? [];
      for (const reason of excerpt.reasons) {
        if (reasons.length < 5 && !reasons.some(existing => JSON.stringify(existing) === JSON.stringify(reason))) reasons.push(reason);
      }
      scoped.set(excerpt.path, reasons);
    }
    packet.files = (await Promise.allSettled([...scoped].map(([path, reasons], position) => describe(path, reasons, false, position < 3))))
      .flatMap(result => {
        if (result.status !== 'fulfilled') return [];
        const file = result.value;
        return file.workingStatus === 'missing' && !file.lastCommit ? [] : [file];
      });
  }

  async function inspect(request: z.infer<z.ZodObject<typeof fileContextInput>>) {
    if (request.version) return readVersion(request.path, request.version, request.startLine, request.endLine);
    const record = await describe(request.path, [], true);
    // Keep ranges and counts if escaped source samples would crowd the MCP transport.
    for (const change of [record.previousChanges, record.changes]) {
      if (JSON.stringify(JSON.stringify(record, null, 2)).length <= 20_000) break;
      for (const hunk of change?.hunks ?? []) {
        delete hunk.lines;
        hunk.truncated = true;
      }
    }
    return record;
  }

  return { inspect, addToPacket };
}
