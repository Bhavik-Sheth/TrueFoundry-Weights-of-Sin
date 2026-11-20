import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const port = 20000 + process.pid % 20000;
const origin = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['dist/local-review.cjs'], {
  env: { ...process.env, CONTEXO_REVIEW_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
const closed = once(child, 'close');
try {
  const [ready] = await Promise.race([once(child.stdout, 'data'), closed]);
  assert.match(String(ready), /Contexo review listening/);
  const result = await fetch(origin);
  assert.equal(result.status, 200);
  assert.match(await result.text(), /Impact graph/);

  async function submit(path, data, expectedStatus = 200) {
    const response = await fetch(origin + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    assert.equal(response.status, expectedStatus);
    return response.json();
  }

  const example = await (await fetch(origin + '/api/example')).json();
  const review = await submit('/api/review', example);
  const hunk = review.hunks[0].id;
  assert.deepEqual(review.findings[0].hunkIds, [hunk]);
  assert.equal(review.checks[0].match, 'candidate digest matched');
  assert.equal(review.impact.added[0].target, 'validate');
  assert.equal(review.impact.removed[0].target, 'clean');

  const rejected = await submit('/api/review', {
    ...example, rejected: [hunk], requirements: [{ text: 'Validate input', hunkIds: [hunk] }],
  });
  assert.equal(rejected.checks[0].match, 'different candidate');
  assert.equal(rejected.findings[0].match, 'unverified revision');
  assert.deepEqual(rejected.requirements[0].hunkIds, [hunk]);
  assert.equal(rejected.impact.added.length, 0);
  await submit('/api/review', { files: [{ path: '../outside.py', base: '', proposed: '# x' }] }, 400);

  const record = { version: 1, runId: 'smoke', sequence: 1, recordedAt: '2026-11-20', evidence: { kind: 'state', state: 'done' } };
  const replay = await submit('/api/replay', { format: 'native', text: JSON.stringify(record) });
  assert.deepEqual(replay.records[0].evidence.payload, record);
  console.log('Local review HTTP smoke test passed.');
} finally {
  child.kill();
  await closed;
}
