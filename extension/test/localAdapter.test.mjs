import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { adapter, decodeTool } from '../trueforge/local-model-adapter.mjs';

const tools = [{ function: { name: 'read_file' } }];
const envelope = '{"name":"read_file","arguments":{"path":"a.py"}}</tool_call>';

test('only normalizes one complete callable envelope', () => {
  expect(decodeTool(envelope, tools)?.function).toEqual({ name: 'read_file', arguments: '{"path":"a.py"}' });
  expect(decodeTool('Example: ' + envelope, tools)).toBeUndefined();
  expect(decodeTool(envelope, [])).toBeUndefined();
  expect(decodeTool(envelope.replace('{"path":"a.py"}', '[]'), tools)).toBeUndefined();
  expect(decodeTool(envelope.slice(0, -1), tools)).toBeUndefined();
});

test('authenticates loopback requests, bounds output and never dispatches a truncated response', async () => {
  const token = 'local-fixture-transport-token';
  const upstream = vi.fn(async (_url, options) => {
    expect(JSON.parse(options.body)).toMatchObject({ stream: false, max_tokens: 2048 });
    expect(options.headers.Authorization).toBeUndefined();
    return Response.json({ id: 'fixture', model: 'fixture', choices: [
      { message: { role: 'assistant', content: envelope }, finish_reason: 'length' },
    ] });
  });
  const server = adapter({ upstream: 'http://127.0.0.1:8080/v1', token, maxOutputTokens: 2048, fetchModel: upstream });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Absent socket');
    const url = 'http://127.0.0.1:' + address.port + '/v1/chat/completions';
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    const allowed = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ max_completion_tokens: 9000, tools }) });
    expect(await allowed.json()).toMatchObject({ choices: [{ message: { content: envelope }, finish_reason: 'length' }] });
    upstream.mockResolvedValueOnce(Response.json({ choices: [
      { message: { role: 'assistant', content: '' }, finish_reason: 'tool_calls' },
    ] }));
    const malformed = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ tools }) });
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ error: { message: expect.stringContaining('valid tool arguments') } });
    expect(upstream).toHaveBeenCalledTimes(2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
});
