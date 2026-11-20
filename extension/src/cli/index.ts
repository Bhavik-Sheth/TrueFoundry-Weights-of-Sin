import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { indexText, loadParser, SymbolIndex, type IndexApi } from '../context/indexer';
import { workspaceText } from './workspace';

export async function loadWorkspaceIndex(root: string): Promise<IndexApi> {
  const parser = await loadParser();
  const index = new SymbolIndex();
  async function reindexFile(path: string) {
    if (!/\.(py|rst|md)$/i.test(path)) return;
    const text = await workspaceText(root, path);
    if (text === undefined) index.removeFile(path);
    else index.setFile(path, indexText(parser, path, text));
  }
  async function reindexAll() {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.py', '*.rst', '*.md'], { cwd: root, maxBuffer: 16 << 20 });
    index.clear();
    for (const path of stdout.split('\0').filter(Boolean)) {
      try { await reindexFile(path); } catch { /* Unreadable or unsupported files are excluded from retrieval. */ }
    }
  }
  await reindexAll();
  return { ready: Promise.resolve(), symbols: () => index.symbols(), inFile: p => index.inFile(p),
    byName: n => index.byName(n), enclosing: (p, l) => index.enclosing(p, l), reindexFile, reindexAll };
}
