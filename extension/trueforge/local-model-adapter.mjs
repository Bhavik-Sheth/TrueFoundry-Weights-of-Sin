/** Opt-in OpenAI-compatible transport for a loopback model with textual tool envelopes. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 4 * 1024 * 1024;

export function decodeTool(content, tools) {
  if (typeof content !== 'string') return undefined;
  // MLX can suppress the opening marker when it abandons tool parsing.
  const envelope = /^(?:<tool_call>\s*)?(\{[\s\S]*\})\s*<\/tool_call>$/.exec(content.trim());
  if (!envelope) return undefined;
  let syntax;
  try { syntax = JSON.parse(envelope[1]); } catch { return undefined; }
  if (!syntax || Object.keys(syntax).length !== 2 || typeof syntax.name !== 'string' ||
      !syntax.arguments || typeof syntax.arguments !== 'object' || Array.isArray(syntax.arguments)) return undefined;
  const available = tools.flatMap(tool => typeof tool.function?.name === 'string' ? [tool.function.name] : []);
  const exact = available.filter(name => name === syntax.name);
  const names = exact.length ? exact : available.filter(name => name.endsWith('__' + syntax.name));
  if (names.length !== 1) return undefined;
  return { id: 'call_' + randomUUID(), type: 'function', function: {
    name: names[0], arguments: JSON.stringify(syntax.arguments),
  } };
}

async function boundedText(source) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of source) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Model transport exceeded the body limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function adapter({ upstream, token, maxOutputTokens, fetchModel = fetch }) {
  const base = new URL(upstream);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' ||
      base.username || base.password || base.pathname !== '/v1' || base.search || base.hash) {
    throw new Error('Use a loopback model URL in the form http://127.0.0.1:PORT/v1.');
  }
  if (typeof token !== 'string' || token.length < 24 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 8192) {
    throw new Error('Provide a token of at least 24 characters and an output budget between 256 and 8192.');
  }
  const credential = Buffer.from('Bearer ' + token);
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
      res.writeHead(401).end();
      return;
    }
    const chat = req.method === 'POST' && req.url === '/v1/chat/completions';
    const models = req.method === 'GET' && req.url === '/v1/models';
    if (!chat && !models) {
      res.writeHead(404).end();
      return;
    }
    const aborted = new AbortController();
    res.once('close', () => aborted.abort());
    try {
      const request = chat ? JSON.parse(await boundedText(req)) : undefined;
      let body;
      if (chat) {
        const requested = request.max_completion_tokens ?? request.max_tokens;
        const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxOutputTokens) : maxOutputTokens;
        const { stream_options, max_completion_tokens, ...other } = request;
        body = JSON.stringify({ ...other, stream: false, max_tokens: limit });
      }
      const response = await fetchModel(base.origin + req.url, {
        method: req.method, body, headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(240_000)]),
      });
      const payload = await boundedText(response.body ?? []);
      if (!response.ok || models) {
        res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(payload);
        return;
      }
      const result = JSON.parse(payload);
      const choice = result.choices?.[0];
      if (choice?.finish_reason === 'stop' && !choice.message?.tool_calls?.length) {
        const call = decodeTool(choice.message?.content, request.tools ?? []);
        if (call) {
          choice.message.content = null;
          choice.message.tool_calls = [call];
          choice.finish_reason = 'tool_calls';
        }
      }
      if (choice?.finish_reason === 'tool_calls' && !choice.message?.tool_calls?.length) {
        res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          error: { message: 'The local model reported a tool call without valid tool arguments.' },
        }));
        return;
      }
      if (!request.stream || !choice?.message) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const { id, created, model } = result;
      const emit = (choices, usage) => res.write('data: ' + JSON.stringify({
        id, created, model, object: 'chat.completion.chunk', choices, usage,
      }) + '\n\n');
      const { content, tool_calls, ...fields } = choice.message;
      emit([{ index: 0, delta: { ...fields, ...(content ? { content } : {}),
        ...(tool_calls?.length ? { tool_calls: tool_calls.map((call, index) => ({ ...call, index })) } : {}),
      }, finish_reason: null }]);
      emit([{ index: 0, delta: {}, finish_reason: choice.finish_reason }]);
      if (request.stream_options?.include_usage && result.usage) emit([], result.usage);
      res.end('data: [DONE]\n\n');
    } catch {
      if (!res.destroyed) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        error: { message: 'The local model transport did not return a usable response.' },
      }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CONTEXO_LOCAL_ADAPTER_PORT ?? 8793);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local adapter port.');
  adapter({
    upstream: process.env.CONTEXO_LOCAL_MODEL_URL ?? 'http://127.0.0.1:8080/v1',
    token: process.env.CONTEXO_LOCAL_ADAPTER_TOKEN,
    maxOutputTokens: Number(process.env.CONTEXO_LOCAL_MAX_OUTPUT_TOKENS ?? 2048),
  }).listen(port, '127.0.0.1', () => console.log('Local model adapter listening on port ' + port));
}
