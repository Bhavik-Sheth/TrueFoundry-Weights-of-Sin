// Fails (exit 1) if the build output contains LLM-provider URLs or SDK imports.
// Usage: node scripts/check-no-provider.mjs [dir=dist]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'dist';
const markers = [
  'api.openai.com',
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

const hits = [];
try {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
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
