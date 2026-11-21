import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import killTree from 'tree-kill';

const local = 'http://127.0.0.1:';
const entry = name => fileURLToPath(new URL(name, import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const requestOptions = { timeoutInSeconds: 2, maxRetries: 0 };

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function run() {
  const lab = await mkdtemp(join(tmpdir(), 'contexo-trueforge-fixture-'));
  const runtimePort = await freePort();
  const modelPort = await freePort();
  const useAdapter = process.env.CONTEXO_FIXTURE_LOCAL_ADAPTER === '1';
  const adapterPort = useAdapter ? await freePort() : modelPort;
  const fixtureKey = useAdapter ? 'disposable-model-adapter-fixture-credential' : 'synthetic-fixture-key';
  const unavailablePort = await freePort();
  const baseUrl = local + runtimePort;
  console.log('TrueForge fixture logs: ' + lab);
  const children = [];
  const launch = (name, command, args, env, shell = false) => {
    const log = createWriteStream(join(lab, name + '.log'));
    const child = spawn(command, args, { env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', error => log.write(error.message));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', () => log.end());
    children.push(child);
    return child;
  };
  try {
    launch('model', process.execPath, [entry('fixtureProvider.mjs'), String(modelPort)], process.env);
    if (useAdapter) {
      launch('adapter', process.execPath, [entry('../../trueforge/local-model-adapter.mjs')], {
        ...process.env, CONTEXO_LOCAL_ADAPTER_PORT: String(adapterPort),
        CONTEXO_LOCAL_MODEL_URL: local + modelPort + '/v1', CONTEXO_LOCAL_ADAPTER_TOKEN: fixtureKey,
      });
    }
    const cli = process.env.CONTEXO_TRUEFORGE_CLI;
    const args = cli ? [cli] : ['-y', '@truefoundry/trueforge@0.185.1'];
    const runtime = launch('runtime', cli ? process.execPath : 'npx', [...args, '--port', String(runtimePort)], {
      ...process.env,
      HOST: '127.0.0.1',
      SQLITE_PATH: join(lab, 'runtime.sqlite'),
      APP_DATA_DIR_SUFFIX: 'contexo-fixture',
      OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1"]',
    }, !cli && process.platform === 'win32');
    const client = new TrueForge({ baseUrl });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await client.server.getCapabilities(requestOptions);
        break;
      } catch (error) {
        if (Date.now() >= deadline || runtime.exitCode !== null) throw new Error('Fixture TrueForge failed to start.', { cause: error });
        await delay(200);
      }
    }

    for (const [kind, port] of [['primary', unavailablePort], ['fallback', adapterPort]]) {
      const name = 'fixture-' + kind;
      await client.settings.modelProviders.createOrUpdate({
        manifest: { type: 'custom', name, baseUrl: local + port + '/v1', auth: { apiKey: fixtureKey },
          models: [{ modelId: 'fixture-model', name: 'fixture-model', properties: {} }] },
      }, requestOptions);
    }
    await client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: 'contexo-editor', description: 'Fixture connector', type: 'remote',
        url: local + unavailablePort + '/mcp', auth: { type: 'header', headers: { 'X-Contexo-Token': 'fixture-token' } },
      },
    }, requestOptions);
    const instructions = await readFile(new URL('../../trueforge/instructions.md', import.meta.url), 'utf8');
    for (const kind of ['primary', 'fallback']) {
      await client.agents.create({
        name: kind === 'primary' ? 'contexo' : 'contexo-fallback',
        description: 'Contexo fixture agent',
        manifest: {
          model: { name: 'fixture-' + kind + '/fixture-model' }, instructions,
          mcpServers: [{
            name: 'contexo-editor', enableTools: ['@all'], requireApprovalForTools: ['propose_write', 'run_command'],
            preload: false, preloadTools: ['assemble_context', 'resume_context', 'read_file', 'search_workspace', 'propose_write', 'batch_plan'],
          }],
        },
      }, requestOptions);
    }
    await new Promise((resolve, reject) => {
      const host = spawn(process.execPath, [entry('run.cjs')], {
        stdio: 'inherit',
        env: { ...process.env, CONTEXO_LIVE_FIXTURE: '1', CONTEXO_FIXTURE_TRUEFORGE_URL: baseUrl },
      });
      host.once('error', reject);
      host.once('exit', code => code === 0 ? resolve() : reject(new Error('The packaged VS Code fixture failed.')));
    });
    assert.match(await readFile(join(lab, 'model.log'), 'utf8'), /Verified versioned file context in model input/);
    const modelLog = await readFile(join(lab, 'model.log'), 'utf8');
    assert.match(modelLog, /Verified run checkpoint and exact packet fingerprint/);
    assert.match(modelLog, /Verified exact source and write coordinates in model input/);
    assert.match(modelLog, /Verified the reviewed range completed its durable batch/);
    console.log('Verified versioned context, checkpoint recovery and exact range edits through the packaged host.');
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (!child.pid || child.exitCode !== null) resolve();
      else killTree(child.pid, 'SIGTERM', () => resolve());
    })));
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
