import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.argv[2]);
const model = 'fixture-model';
http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'fixture' }] }));
    return;
  }
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  try {
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const tools = (body.tools ?? []).map(x => x.function?.name).filter(Boolean);
    const results = body.messages?.filter(x => x.role === 'tool') ?? [];
    const tool = results.length;
    if (tool === 1) {
      const context = JSON.stringify(results[0].content);
      assert.match(context, /inline\.py · needed for: selection/);
      assert.match(context, /Set the inline fixture baseline/);
      assert.match(context, /Last commit delta/);
      assert.match(context, /-value = 10(?!\d)/);
      assert.match(context, /\+value = 1029/);
      console.log('Verified versioned file context in model input.');
    }
    if (tool === 2) {
      const checkpoint = JSON.parse(results[1].content);
      assert.equal(checkpoint.status, 'checkpoint');
      assert.equal(checkpoint.lastContext.sha256, createHash('sha256').update(results[0].content).digest('hex'));
      assert.ok(checkpoint.lastContext.turnId);
      assert.equal(checkpoint.lastContext.excerpts[0].path, 'inline.py');
      console.log('Verified run checkpoint and exact packet fingerprint.');
    }
    const source = tool === 4 ? JSON.parse(results[2].content) : undefined;
    if (source) {
      assert.equal(source.rangeWritable, true);
      assert.equal(source.text, 'value = 1029\n');
      assert.equal(source.hash, createHash('sha256').update(source.text).digest('hex'));
      console.log('Verified exact source and write coordinates in model input.');
    }
    const plan = tool >= 4 ? JSON.parse(results[3].content) : undefined;
    if (tool === 6) {
      assert.equal(JSON.parse(results[5].content).status, 'complete');
      console.log('Verified the reviewed range completed its durable batch.');
    }
    const names = ['assemble_context', 'resume_context', 'read_file', 'batch_plan', 'propose_write', 'batch_plan'];
    const name = tool < names.length ? tools.find(x => x.endsWith(names[tool])) : undefined;
    assert.ok(tool >= names.length || name, 'Missing fixture tool ' + names[tool]);
    const args = tool === 0 ? { request: 'Update the selected fixture value' } : tool === 1 ? { offset: 0 }
      : tool === 2 ? { path: 'inline.py', startLine: 1, endLine: 1 }
        : tool === 3 ? { action: 'create', batches: [{ id: 'fixture', goal: 'Update fixture', files: ['inline.py'], after: [] }] }
          : tool === 4 && source ? { summary: 'Update the selected fixture value', edits: [{ path: 'inline.py',
            baseHash: source.hash, startLine: source.startLine, endLine: source.endLine, newText: 'value = 3097' }] }
            : tool === 5 ? { action: 'complete', revision: plan.revision, proposalKey: JSON.parse(results[4].content).proposalKey }
              : undefined;
    const textual = process.env.CONTEXO_FIXTURE_LOCAL_ADAPTER === '1';
    const delta = name && textual ? { content: JSON.stringify({ name, arguments: args }) + '\n</tool_call>' }
      : name ? { tool_calls: [{
      index: 0, id: 'call_fixture_' + tool, type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }] } : { content: 'Fixture response.' };
    console.log('Fixture request', req.url, 'tool results', tool, 'reply', name ?? 'text');
    const meta = { id: 'chatcmpl-fixture-' + tool, created: 1, model };
    const reason = name && !textual ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      for (const item of [{ delta: { role: 'assistant' }, finish_reason: null }, { delta, finish_reason: null }, { delta: {}, finish_reason: reason }]) {
        res.write('data: ' + JSON.stringify({ ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, ...item }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...meta, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    }
  } catch (error) {
    console.error(error.message);
    res.writeHead(400).end();
  }
}).listen(port, '127.0.0.1');
