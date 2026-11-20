// Run npm run build before registering the agents from a clean checkout.
import { existsSync } from 'node:fs';
const cli = new URL('../dist/register.cjs', import.meta.url);
if (existsSync(cli)) await import(cli.href);
else {
  console.error('Registration CLI is missing. Run npm run build in extension/ first.');
  process.exitCode = 1;
}
