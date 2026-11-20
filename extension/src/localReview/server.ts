import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readGitHistory } from './gitHistory';
import { analyzeReview } from './model';
import { importReplay, readReplay } from '../replay/records';
import { sha256, proposalKey } from '../review/proposal';

const directory = resolve(__dirname, '../local-review');
const port = Number(process.env.CONTEXO_REVIEW_PORT ?? '18792');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid review port');
const origin = 'http://127.0.0.1:' + port;
const base = 'def compute(value):\n    return clean(value)\n';
const proposed = 'def compute(value):\n    return validate(value)\n';
const demo = {
  files: [{ path: 'src/calculation.py', base, proposed }],
  checks: [{ name: 'Fixture test report', source: 'Example', status: 'passed',
    candidateDigest: proposalKey([['src/calculation.py', sha256(proposed)]]) }],
  findings: [{ path: 'src/calculation.py', name: 'Review validation behavior', side: 'candidate',
    startLine: 2, sha256: sha256(proposed) }],
};

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/glow.js', ['glow.js', 'text/javascript']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/app.css', ['app.css', 'text/css']],
]);

createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
  };
  if (req.headers.host !== '127.0.0.1:' + port || (req.headers.origin && req.headers.origin !== origin)) {
    return json(403, { error: 'Open the review app at ' + origin });
  }
  try {
    const asset = assets.get(req.url ?? '');
    if (req.method === 'GET' && asset) {
      const [file, type] = asset;
      const content = await readFile(join(directory, file));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(content);
    } else if (req.method === 'GET' && req.url === '/api/commits') {
      try {
        json(200, await readGitHistory(resolve(directory, '../..')));
      } catch {
        json(503, { error: 'Git history could not be read from this checkout.' });
      }
    } else if (req.method === 'GET' && req.url === '/api/example') {
      json(200, demo);
    } else if (req.method === 'POST' && (req.url === '/api/review' || req.url === '/api/replay')) {
      if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Expected JSON.' });
      const body: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) return json(413, { error: 'Request exceeds 4 MiB.' });
        body.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (req.url === '/api/review') return json(200, await analyzeReview(input));
      if (!input || typeof input.text !== 'string' || !['native', 'acp', 'otlp'].includes(input.format)) {
        return json(400, { error: 'Provide replay text and a supported format.' });
      }
      const imported = importReplay(input.text, input.format);
      json(200, readReplay(imported.content));
    } else {
      json(404, { error: 'Unknown resource.' });
    }
  } catch (error) {
    json(400, { error: error instanceof Error ? error.message : 'Unable to process the request.' });
  }
}).listen(port, '127.0.0.1', () => console.log('Contexo review listening at ' + origin));
