import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { useTerminalLogging } from '../log';
import { analyzeReview } from '../localReview/model';
import { readGitHistory } from '../localReview/gitHistory';
import { importReplay, readReplay } from '../replay/records';
import { createAdmin } from '../run/trueforgeAdmin';
import { workspaceText } from './workspace';
import { sha256 } from '../review/proposal';
import { assist } from './assistant';

async function main() {
  useTerminalLogging();
  const { positionals: [cmd, ...args], values } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string' }, format: { type: 'string' }, file: { type: 'string' }, lines: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!cmd || values.help || cmd === 'help') {
    console.log('contexo ask [--root DIR] [--check] "request"\ncontexo inline --file PATH --lines FIRST-LAST [--root DIR] "instruction"\ncontexo doctor\ncontexo commits [--root DIR]\ncontexo review FILE.json\ncontexo replay FILE [--format native|acp|otlp]');
    return;
  }
  const url = process.env.TRUEFORGE_URL || 'http://localhost:8790';
  let result: unknown;
  if (cmd === 'doctor') {
    const admin = createAdmin(url);
    if (!await admin.health()) throw new Error('TrueForge is unavailable at ' + url);
    result = { trueforge: url, models: await admin.listModels() };
  } else if (cmd === 'ask' || cmd === 'inline' || cmd === 'commits') {
    const root = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: values.root, encoding: 'utf8' }).trimEnd());
    if (cmd !== 'commits') {
      if (!args.join(' ').trim()) throw new Error('Supply a request for the assistant.');
      if (cmd === 'ask') return assist(root, args.join(' '), url, undefined, values.check);
      const match = /^(\d+)-(\d+)$/.exec(values.lines ?? '');
      if (!values.file || !match) throw new Error('Inline requires --file PATH and --lines FIRST-LAST.');
      const content = await workspaceText(root, values.file);
      if (content === undefined) throw new Error('The selected file does not exist.');
      const lines = content.split(/\r?\n/);
      const first = Number(match[1]), last = Number(match[2]);
      if (first < 1 || last < first || last > lines.length) throw new Error('Selection lies outside the file.');
      return assist(root, args.join(' '), url, { path: values.file, startLine: first - 1, endLine: last - 1,
        text: lines.slice(first - 1, last).join('\n'), hash: sha256(content), docVersion: 0 }, values.check);
    }
    result = await readGitHistory(root);
  } else if (cmd === 'review' || cmd === 'replay') {
    if (args.length !== 1 || (await stat(args[0])).size > 16 << 20) throw new Error('Supply one input file under 16 MiB.');
    const text = await readFile(args[0], 'utf8');
    const format = values.format ?? 'native';
    if (format !== 'native' && format !== 'acp' && format !== 'otlp') throw new Error('Unknown replay format');
    result = cmd === 'review' ? await analyzeReview(JSON.parse(text)) : readReplay(importReplay(text, format).content);
  } else throw new Error('Unknown command: ' + cmd);
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
