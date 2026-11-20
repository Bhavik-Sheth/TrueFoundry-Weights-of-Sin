import * as vscode from 'vscode';
import { mkdir, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunJournal } from '../run/journal';
import { importReplay, readReplay } from './records';

const maxBytes = 16 * 1024 * 1024;

export function registerReplay(ctx: vscode.ExtensionContext, directory: string, journal: RunJournal) {
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.importRun', async () => {
    const format = await vscode.window.showQuickPick(['native', 'acp', 'otlp'] as const, {
      placeHolder: 'Choose Contexo JSONL, ACP session update JSONL, or OTLP span JSON',
    });
    if (format !== 'native' && format !== 'acp' && format !== 'otlp') return;
    const [file] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Records: ['json', 'jsonl'] } }) ?? [];
    if (!file) return;
    const stat = await vscode.workspace.fs.stat(file);
    if (stat.size > maxBytes) throw new Error('Replay imports are limited to 16 MiB.');
    const bytes = await vscode.workspace.fs.readFile(file);
    if (bytes.length > maxBytes) throw new Error('Replay imports are limited to 16 MiB.');
    const result = importReplay(new TextDecoder('utf-8', { fatal: true }).decode(bytes), format);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = join(directory, randomUUID() + '.tmp');
    try {
      await writeFile(staging, result.content, { flag: 'wx', mode: 0o600, flush: true });
      try {
        await link(staging, join(directory, result.id + '.jsonl'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await unlink(staging).catch(() => {});
    }
    await openReplay(journal, result.id);
  }));
  ctx.subscriptions.push(vscode.commands.registerCommand('contexo.replayRun', async () => {
    await journal.flush();
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const id = await vscode.window.showQuickPick(files.filter(file => /^[\w-]+\.jsonl$/.test(file)).map(file => file.slice(0, -6)), {
      placeHolder: 'Choose a run to inspect',
    });
    if (id) await openReplay(journal, id);
  }));
}

async function openReplay(journal: RunJournal, id: string) {
  const { records, skipped } = readReplay(await journal.read(id));
  if (!records.length) throw new Error('No readable events in this run.');
  if (skipped) void vscode.window.showWarningMessage('Skipped ' + skipped + ' unreadable replay records.');
  const options = records.map((record, index) => ({
    label: (index + 1) + '. ' + (typeof record.evidence.name === 'string' ? record.evidence.name : record.evidence.kind),
    description: record.recordedAt, index,
  }));
  let index = (await vscode.window.showQuickPick(options, { placeHolder: 'Choose a starting event' }))?.index;
  while (index !== undefined) {
    const current: number = index;
    const record = records[current];
    const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(record, null, 2), language: 'json' });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const choices = [
      ...(current > 0 ? [{ label: 'Previous event', index: current - 1 }] : []),
      ...(current + 1 < records.length ? [{ label: 'Next event', index: current + 1 }] : []),
      { label: 'Jump to event', index: -1 },
    ];
    const next = await vscode.window.showQuickPick(choices, { placeHolder: options[current].label });
    index = next?.index === -1 ? (await vscode.window.showQuickPick(options))?.index : next?.index;
  }
}
