// Opt-in release check. Uses pinned disposable clones and the production CLI context/review code.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
import { loadWorkspaceIndex } from '../../src/cli/index';
import { applyReviewed, stage, workspaceText } from '../../src/cli/workspace';
import { assembleContext, prepareContextForModel } from '../../src/context/assembler';
import { fileContextReader } from '../../src/context/fileContext';
import { ripgrepSearch } from '../../src/context/search';
import { sha256 } from '../../src/review/proposal';
import type { Run } from '../../src/types';

const cases = [
  { repo: 'flask', path: 'src/flask/helpers.py', query: 'get_debug_flag', old: 'val.lower() not in {"0", "false", "no"}',
    next: 'val.lower() not in {"0", "false", "no", "off"}', lang: 'Python', instruction: 'Add the string "off" to the set of false values at the end of the set.' },
  { repo: 'sync', path: 'semaphore/semaphore.go', query: 'TryAcquire', old: 'success := s.size-s.cur >= n && s.waiters.Len() == 0',
    next: 'success := n >= 0 && s.size-s.cur >= n && s.waiters.Len() == 0', lang: 'Go', instruction: 'Reject negative semaphore weights. Immediately after :=, insert n >= 0 && followed by a space. Keep the rest of the current line byte-for-byte.' },
  { repo: 'ripgrep', path: 'crates/globset/src/lib.rs', query: 'GlobSetBuilder', old: 'GlobSetBuilder { pats: vec![] }',
    next: 'GlobSetBuilder { pats: Vec::new() }', lang: 'Rust', instruction: 'Initialize the empty pats vector using Vec::new() in place of the vec! macro.' },
];

async function main() {
  const rgPath = execFileSync('which', ['rg'], { encoding: 'utf8' }).trim();
  let rejected = 0;
  for (const item of cases) {
    const root = await realpath(join(process.argv[2], item.repo));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const run: Run = { id: item.repo, mode: 'agent', request: item.query, sessionId: 'oss-probe',
      state: 'streaming', agent: 'contexo', sealedSessions: [] };
    const index = await loadWorkspaceIndex(root);
    const packet = await assembleContext({ request: item.query, runId: run.id, budget: 1300,
      rg: term => ripgrepSearch(term, { cwd: root, rgPath, max: 50 }) }, index);
    await fileContextReader(root, index).addToPacket(packet);
    const { delivery } = prepareContextForModel(packet);
    const excerpt = packet.excerpts.find(candidate => candidate.path === item.path && delivery.excerptIds.includes(candidate.id));
    assert.ok(excerpt, `Missing ${item.path} for identifier ${item.query}; delivered ${packet.excerpts.filter(e => delivery.excerptIds.includes(e.id)).map(e => e.path).join(", ")}`);
    if (item.lang !== 'Python') assert.equal(excerpt.reasons[0].kind, 'source-preview');
    const source = await workspaceText(root, item.path);
    assert.ok(source);
    let replacement = item.next;
    if (process.env.CONTEXO_TEST_BONSAI === '1') {
      const row = source.split('\n').find(line => line.includes(item.old));
      assert.ok(row);
      const response = await fetch('http://127.0.0.1:38694/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'default_model', temperature: 0, max_tokens: 180, messages: [{
          role: 'user', content: `Edit this ${item.lang} source line. ${item.instruction} Return just the complete updated line.\n\n${row}`,
        }] }), signal: AbortSignal.timeout(45_000),
      });
      assert.ok(response.ok, `MLX returned HTTP ${response.status}`);
      const payload = await response.json() as { choices: Array<{ message: { content: string } }>; usage: unknown };
      const updated = payload.choices[0].message.content.trim().replace(/^```[^\n]*\n/, '').replace(/\n?```$/, '').trim();
      const expected = row.replace(item.old, item.next).trim();
      if (updated !== expected) {
        rejected++;
        console.error(JSON.stringify({ model: 'Bonsai-4B-mlx-1bit', language: item.lang, result: 'rejected', candidate: updated }));
        continue;
      }
      const leading = row.slice(0, row.indexOf(item.old)).trimStart();
      const trailing = row.slice(row.indexOf(item.old) + item.old.length).trimEnd();
      replacement = updated.slice(leading.length, updated.length - trailing.length);
      console.log(JSON.stringify({ model: 'Bonsai-4B-mlx-1bit', language: item.lang, usage: payload.usage }));
    }
    const args = { summary: 'Fixture change to ' + item.query, edits: [
      { path: item.path, baseHash: sha256(source), oldText: item.old, newText: replacement },
    ] };
    await assert.rejects(stage(root, run, 'write', 'main', { ...args, edits: [{ ...args.edits[0], baseHash: 'stale' }] }), /STALE_BASE/);
    const proposal = await stage(root, run, 'write', 'main', args);
    assert.equal(await workspaceText(root, item.path), source);
    assert.equal(proposal.hunks.length, 1);
    proposal.hunks[0].decision = 'accepted';
    await applyReviewed(root, proposal, () => true);
    assert.equal(git('diff', '--name-only'), item.path);
    assert.equal(await workspaceText(root, item.path), source.replace(item.old, item.next));
    if (item.lang === 'Go') {
      await writeFile(join(root, 'semaphore/contexo_fixture_test.go'),
        'package semaphore\nimport "testing"\nfunc TestContexoNegativeWeight(t *testing.T) {\n' +
        ' s := NewWeighted(1)\n if s.TryAcquire(-1) { t.Fatal("accepted negative weight") }\n' +
        ' if !s.TryAcquire(1) { t.Fatal("positive weight failed") }\n}\n');
    }
    const command = item.lang === 'Python'
      ? ['python3', '-B', '-c',
        'import os,sys; sys.path.insert(0,"src"); from flask.helpers import get_debug_flag; os.environ["FLASK_DEBUG"]="off"; assert get_debug_flag() is False; os.environ["FLASK_DEBUG"]="1"; assert get_debug_flag() is True']
      : item.lang === 'Go' ? ['go', 'test', './semaphore'] : process.env.CONTEXO_TEST_RUST === '1'
        ? ['cargo', 'test', '-p', 'globset'] : undefined;
    if (command) {
      const check = spawnSync(command[0], command.slice(1), { cwd: root, stdio: 'inherit', timeout: 180_000 });
      if (check.error) throw check.error;
      assert.equal(check.status, 0);
    }
    console.log(JSON.stringify({ language: item.lang, revision: git('rev-parse', 'HEAD'),
      trackedFiles: git('ls-files').split('\n').length, target: item.path,
      reason: excerpt.reasons[0].kind, packetTokens: delivery.packetTokens,
      verification: command ? command.slice(0, 3).join(' ') : 'exact diff + stale-base rejection' }));
  }
  assert.equal(rejected, 0, 'One or more model proposals were rejected before staging');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
