// Fails (exit 1) if the build output contains LLM-provider URLs or SDK imports.
// Usage: node scripts/check-no-provider.mjs [dir=dist]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'dist';
const markers = [
  'api.openai.com',
  '127.0.0.1:11434',
  'localhost:11434',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.groq.com',
  '@anthropic-ai/sdk',
  /require\(["']openai["']\)/,
  /from ["']openai["']/,
  /node_modules\/openai\//,
];
const skip = /\.(wasm|png|jpg|jpeg|gif|ico|vsix|map)$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (!skip.test(p)) yield p;
  }
}

const archive = root.toLowerCase().endsWith('.vsix');
function readZip(listing, file) {
  const unpacker = process.platform === 'win32' ? 'tar' : 'unzip';
  const args = process.platform === 'win32'
    ? (listing ? ['-tf', root] : ['-xOf', root, file])
    : (listing ? ['-Z1', root] : ['-p', root, file]);
  return execFileSync(unpacker, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

const hits = [];
try {
  const files = archive
    ? readZip(true).split(/\r?\n/).filter(name => /^extension\/dist\/.+\.(?:[cm]?js|json|html|css)$/.test(name))
    : [...walk(root)];
  if (archive && !files.includes('extension/dist/extension.js')) throw new Error('Packaged host bundle is missing');
  for (const file of files) {
    const text = archive ? readZip(false, file) : readFileSync(file, 'utf8');
    for (const m of markers) {
      if (typeof m === 'string' ? text.includes(m) : m.test(text)) hits.push(`${file}: ${m}`);
    }
  }
} catch (e) {
  console.error(`check-no-provider: cannot scan "${root}": ${e.message}`);
  process.exit(1);
}
if (hits.length) {
  console.error('Provider markers found:\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`check-no-provider: ${root} is clean`);
