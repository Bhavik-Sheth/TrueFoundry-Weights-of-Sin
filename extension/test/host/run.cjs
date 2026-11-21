const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdir, mkdtemp, readdir, readFile, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const marker = 'Contexo host smoke passed:';
const vscode = process.env.VSCODE_CLI || 'code';

async function portForFixture() {
  const server = createServer();
  await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function main() {
  const lab = await mkdtemp(join(tmpdir(), 'contexo-vscode-smoke-'));
  console.log('Smoke-test workspace and logs: ' + lab);
  const workspace = join(lab, 'workspace');
  const multi = process.env.CONTEXO_FIXTURE_MULTI_ROOT === '1';
  const primary = join(lab, 'primary');
  if (multi) {
    await mkdir(primary);
    await writeFile(join(primary, 'inline.py'), 'value = 77\n');
  }
  const profile = join(lab, 'profile');
  process.env.CONTEXO_SMOKE_PROFILE = profile;
  const installed = join(lab, 'extensions');
  const development = join(lab, 'test');
  await Promise.all([join(workspace, '.vscode'), profile, installed, development].map(folder => mkdir(folder, { recursive: true })));
  await writeFile(join(development, 'package.json'), JSON.stringify({
    name: 'contexo-smoke', publisher: 'fixture', version: '0.0.1', engines: { vscode: '^1.90.0' },
  }));
  const settings = {
    'contexo.mcpPort': await portForFixture(),
    'contexo.autoStartTrueForge': false,
    'contexo.autoRegisterTrueForge': false,
    'contexo.stopTrueForgeOnExit': 'never',
    ...(process.env.CONTEXO_FIXTURE_TRUEFORGE_URL ? { 'contexo.trueforgeUrl': process.env.CONTEXO_FIXTURE_TRUEFORGE_URL } : {}),
  };
  const target = multi ? join(lab, 'fixture.code-workspace') : workspace;
  if (multi) await writeFile(target, JSON.stringify({ folders: [{ path: primary }, { path: workspace }], settings }));
  else await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings));
  const lines = ['value = 1', ...Array.from({ length: 20 }, (_, i) => `filler_${i} = ${i}`), 'other = 2', ''];
  await writeFile(join(workspace, 'example.py'), lines.join('\n'));

  if (process.env.CONTEXO_LIVE_FIXTURE === '1') {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=Contexo fixture', '-c',
        'user.email=contexo@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, stdio: 'inherit' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0);
    };
    git('init', '-q');
    const inline = join(workspace, 'inline.py');
    await writeFile(inline, 'value = 10\n');
    git('add', 'example.py', 'inline.py');
    git('commit', '-qm', 'Introduce inline fixture');
    await writeFile(inline, 'value = 1029\n');
    git('commit', '-qam', 'Set the inline fixture baseline');
  }
  const options = ['--user-data-dir', profile, '--extensions-dir', installed];
  const launch = args => {
    const result = spawnSync(vscode, [...options, ...args], { stdio: 'inherit', timeout: 150_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'VS Code CLI exited with a failure');
  };
  launch(['--install-extension', resolve(__dirname, '../../dist/contexo.vsix'), '--force']);
  launch([
    '--new-window', '--wait', '--skip-welcome', '--disable-workspace-trust', '--disable-extension', 'github.copilot-chat',
    '--extensionDevelopmentPath', development, '--extensionTestsPath', join(__dirname, 'agentBridge.cjs'), target,
  ]);
  const logs = join(profile, 'logs');
  let combined = '';
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    const files = await readdir(logs, { recursive: true });
    const output = await Promise.all(files.filter(file => file.endsWith('renderer.log')).map(file => readFile(join(logs, file), 'utf8')));
    combined = output.join('\n');
    if (combined.includes(marker) || combined.includes('AssertionError [ERR_ASSERTION]')) break;
    await new Promise(done => setTimeout(done, 150));
  }
  assert.ok(combined.includes(marker), 'The extension host did not report passing assertions. See the smoke-test logs.');
  if (process.env.CONTEXO_CLAUDE_EXECUTABLE) {
    assert.ok(combined.includes('Claude Code MCP connection verified.'));
    console.log('Claude Code MCP connection verified.');
  }
  if (process.env.CONTEXO_LIVE_FIXTURE === '1') {
    assert.ok(combined.includes('Live TrueForge inline apply verified'));
    console.log('Live TrueForge inline apply verified.');
  }
  const passed = combined.split('\n').find(line => line.includes(marker));
  console.log(passed.slice(passed.indexOf(marker)));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
