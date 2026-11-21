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
    const names = ['assemble_context', 'resume_context', 'propose_write'];
    const name = tool < names.length ? tools.find(x => x.endsWith(names[tool])) : undefined;
    assert.ok(tool >= names.length || name, 'Missing fixture tool ' + names[tool]);
    const args = tool === 0 ? { request: 'Update the selected fixture value' } : tool === 1 ? { offset: 0 }
      : { summary: 'Update the selected fixture value', edits: [{ path: 'inline.py',
        baseHash: createHash('sha256').update('value = 1029\n').digest('hex'), oldText: 'value = 1029', newText: 'value = 3097' }] };
    const delta = name ? { tool_calls: [{
      index: 0, id: 'call_fixture_' + tool, type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }] } : { content: 'Fixture response.' };
    console.log('Fixture request', req.url, 'tool results', tool, 'reply', name ?? 'text');
    const meta = { id: 'chatcmpl-fixture-' + tool, created: 1, model };
    const reason = name ? 'tool_calls' : 'stop';
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
