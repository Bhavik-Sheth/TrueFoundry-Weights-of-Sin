const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, readdir, writeFile } = require('node:fs/promises');
const vscode = require('vscode');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function run() {
  const extension = vscode.extensions.getExtension('contexo.contexo');
  assert.ok(extension, 'Install the Contexo VSIX in the test profile');
  await extension.activate();

  const [workspace, secondary] = vscode.workspace.workspaceFolders;
  if (process.env.CONTEXO_FIXTURE_MULTI_ROOT === '1') {
    assert.ok(secondary, 'Second fixture root is available');
    await vscode.commands.executeCommand('contexo.selectWorkspaceRoot', secondary.uri);
    await runLiveInline(secondary);
    const original = vscode.Uri.joinPath(workspace.uri, 'inline.py');
    assert.equal(await readFile(original.fsPath, 'utf8'), 'value = 77\n');
    console.log('Contexo host smoke passed: selected second root, exact range applied, first root untouched.');
    return;
  }
  const uri = vscode.Uri.joinPath(workspace.uri, 'example.py');
  const initial = await readFile(uri.fsPath, 'utf8');
  const editor = await vscode.window.showTextDocument(uri);
  editor.selection = new vscode.Selection(0, 0, 1, 0);
  const originalClipboard = await vscode.env.clipboard.readText();
  let token;
  try {
    await vscode.commands.executeCommand('contexo.copyAgentConnection', 'Agent token');
    token = await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }
  assert.match(token, /^[a-f0-9]{64}$/);

  const port = vscode.workspace.getConfiguration('contexo').get('mcpPort');
  const endpoint = 'http://127.0.0.1:' + port + '/mcp/agent';
  let requestId = 0;
  const request = (method, params, credential = token) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Contexo-Token': credential,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++requestId }),
  });
  const rpc = async (method, params) => {
    const response = await request(method, params);
    assert.equal(response.status, 200);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const json = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await request('tools/list', {}, 'wrong')).status, 401);
  const tools = (await rpc('tools/list', {})).tools.map(tool => tool.name);
  assert.ok(tools.includes('assemble_context') && tools.includes('review_status') && tools.includes('file_context'));
  assert.ok(!tools.includes('run_command'));
  assert.equal((await json('editor_selection', {})).text, 'value = 1\n');
  const context = await call('assemble_context', { request: 'Change value', useEditorSelection: true });
  assert.match(context.content[0].text, /value = 1/);
  assert.match(context.content[0].text, /example\.py · needed for: selection/);
  const fileInfo = await json('file_context', { path: 'example.py' });
  assert.equal(fileInfo.source, 'editor buffer');
  assert.equal(fileInfo.workingStatus, 'text');

  const read = await json('read_file', { path: 'example.py', startLine: 1, endLine: 1 });
  assert.equal(read.text, 'value = 1\n');
  const proposalArgs = {
    requestId: 'fixture-two-hunks',
    summary: 'Change two independent constants',
    edits: [
      { path: 'example.py', baseHash: read.hash, oldText: 'value = 1', newText: 'value = 3' },
      { path: 'example.py', baseHash: read.hash, oldText: 'other = 2', newText: 'other = 4' },
    ],
  };
  const proposal = await json('propose_write', proposalArgs);
  assert.equal((await json('propose_write', proposalArgs)).reviewId, proposal.reviewId);
  assert.equal(proposal.status, 'reviewing');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri.toString());
  assert.equal(await readFile(uri.fsPath, 'utf8'), initial);
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 30);
  const apply = lenses.find(lens => lens.command?.command === 'contexo.proposal.apply').command;
  const decisions = lenses.filter(lens => lens.command?.command === 'contexo.hunk.decide').map(lens => lens.command.arguments);
  const accept = decisions.find(([, , decision]) => decision === 'accepted');
  const reject = decisions.find(([, hunkId, decision]) => decision === 'rejected' && hunkId !== accept[1]);
  assert.ok(accept && reject, 'Two separate hunks have in-file CodeLens actions');
  await vscode.commands.executeCommand('contexo.hunk.decide', ...accept);
  await vscode.commands.executeCommand('contexo.hunk.decide', ...reject);
  await vscode.commands.executeCommand(apply.command, ...apply.arguments);
  const end = await json('review_status', { reviewId: proposal.reviewId });
  assert.equal(end.status, 'applied');
  assert.deepEqual(end.applied, [accept[1]]);
  assert.deepEqual(end.rejected, [reject[1]]);
  const appliedText = await readFile(uri.fsPath, 'utf8');
  assert.equal(appliedText, initial.replace('value = 1', 'value = 3'));
  await vscode.commands.executeCommand('contexo.undoHunk', accept[1]);
  assert.equal(await readFile(uri.fsPath, 'utf8'), initial);
  await vscode.commands.executeCommand('contexo.redoHunk', accept[1]);
  assert.equal(await readFile(uri.fsPath, 'utf8'), appliedText);

  const current = await json('read_file', { path: 'example.py' });
  const second = await json('propose_write', {
    summary: 'Change value again',
    edits: [{ path: 'example.py', baseHash: current.hash, oldText: 'value = 3', newText: 'value = 7' }],
  });
  await vscode.commands.executeCommand('contexo.proposal.acceptAll', second.reviewId);
  const active = vscode.window.activeTextEditor;
  assert.ok(await active.edit(edit => edit.replace(active.document.lineAt(0).range, 'value = 9')));
  await vscode.commands.executeCommand('contexo.proposal.apply', second.reviewId);
  assert.equal((await json('review_status', { reviewId: second.reviewId })).status, 'stale');
  assert.equal(active.document.lineAt(0).text, 'value = 9');
  assert.equal(await readFile(uri.fsPath, 'utf8'), appliedText);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  const claude = process.env.CONTEXO_CLAUDE_EXECUTABLE;
  if (claude) {
    const config = await mkdtemp(join(tmpdir(), 'contexo-claude-config-'));
    const exec = promisify(execFile);
    const options = {
      cwd: workspace.uri.fsPath, timeout: 25_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CONTEXO_AGENT_TOKEN: token },
    };
    const server = { type: 'http', url: endpoint, headers: { 'X-Contexo-Token': '${CONTEXO_AGENT_TOKEN}' } };
    await exec(claude, ['mcp', 'add-json', '--scope', 'local', 'contexo', JSON.stringify(server)], options);
    const { stdout } = await exec(claude, ['mcp', 'list'], options);
    assert.ok(/contexo[^\n]*connected/i.test(stdout) && !/contexo[^\n]*failed/i.test(stdout), 'Claude Code connects to Contexo over MCP');
    console.log('Claude Code MCP connection verified.');
  }

  if (process.env.CONTEXO_LIVE_FIXTURE === '1') {
    const gitFile = await json('file_context', { path: 'inline.py' });
    assert.equal(gitFile.lastCommit?.subject, 'Set the inline fixture baseline', JSON.stringify(gitFile));
    await runLiveInline(workspace);
  }
  console.log('Contexo host smoke passed: scoped MCP, context, source CodeLens, mixed apply, undo/redo, stale buffer.');
}

async function runLiveInline(workspace) {
  const file = vscode.Uri.joinPath(workspace.uri, 'inline.py');
  const base = 'value = 1029\n';
  await writeFile(file.fsPath, base);
  const source = await vscode.window.showTextDocument(file);
  source.selection = new vscode.Selection(0, 0, 0, 12);
  await vscode.commands.executeCommand('contexo.inlineEdit',
    'Change the selected line from value = 1029 to value = 3097. Stage that exact one-line edit only.');
  const liveLenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file, 20);
  const decide = liveLenses.find(lens => lens.command?.command === 'contexo.hunk.decide' &&
    lens.command.arguments[2] === 'accepted')?.command;
  const save = liveLenses.find(lens => lens.command?.command === 'contexo.proposal.apply')?.command;
  assert.ok(decide && save, 'A live TrueForge turn stages the edit in the source file');
  assert.equal(await readFile(file.fsPath, 'utf8'), base);
  await vscode.commands.executeCommand(decide.command, ...decide.arguments);
  await vscode.commands.executeCommand(save.command, ...save.arguments);
  assert.equal(await readFile(file.fsPath, 'utf8'), 'value = 3097\n');
  const journals = join(process.env.CONTEXO_SMOKE_PROFILE, 'User', 'workspaceStorage');
  const deadline = Date.now() + 20_000;
  let completed = false;
  while (Date.now() < deadline && !completed) {
    const files = await readdir(journals, { recursive: true });
    const journalsOnDisk = files.filter(name => name.split(/[\\/]/).includes('runs'));
    const records = [];
    for (const name of journalsOnDisk) {
      if (name.endsWith('.jsonl')) records.push(await readFile(join(journals, name), 'utf8'));
      if (name.endsWith('/journal.sqlite') || name.endsWith('\\journal.sqlite')) {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(join(journals, name), { readOnly: true });
        try {
          const byRun = new Map();
          for (const row of db.prepare('SELECT run_id, record FROM journal_events ORDER BY run_id, sequence').all()) {
            const run = byRun.get(row.run_id) ?? [];
            run.push(row.record);
            byRun.set(row.run_id, run);
          }
          records.push(...[...byRun.values()].map(run => run.join('\n')));
        } finally {
          db.close();
        }
      }
    }
    for (const content of records) {
      const events = content.trim().split('\n').flatMap(line => {
        try { return [JSON.parse(line).evidence]; } catch { return []; }
      });
      if (!events.some(event => event.kind === 'request' && event.mode === 'inline')) continue;
      completed = events.some(event => event.kind === 'state' && event.state === 'done');
      if (completed && process.env.CONTEXO_FIXTURE_TRUEFORGE_URL) {
        assert.equal(events.filter(event => event.kind === 'session').length, 2);
        assert.ok(events.some(event => event.kind === 'context' && event.delivery.excerptIds.length > 0));
        assert.ok(events.some(event => event.kind === 'approval-intent' && event.allow));
      }
    }
    if (!completed) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(completed, 'The TrueForge turn completes after the apply and approval');
  console.log('Live TrueForge inline apply verified on a disposable source file.');
}

module.exports = { run };
