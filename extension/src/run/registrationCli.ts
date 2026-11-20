import { createAdmin } from './trueforgeAdmin';
import instructions from '../../trueforge/instructions.md';

async function main(): Promise<void> {
  const { CONTEXO_TOKEN: token, PRIMARY_MODEL: primaryModel, FALLBACK_MODEL: fallbackModel } = process.env;
  const port = Number(process.env.CONTEXO_PORT ?? '8791');
  if (!token || !primaryModel || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set CONTEXO_TOKEN, PRIMARY_MODEL and a valid CONTEXO_PORT (default 8791).');
  }
  const baseUrl = new URL(process.env.TRUEFORGE_URL ?? 'http://localhost:8790');
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('Use an HTTP or HTTPS TrueForge URL without embedded credentials.');
  }
  const sandbox = process.env.CONTEXO_SANDBOX?.trim();
  const skills = process.env.CONTEXO_SKILLS?.split(',').map(skill => skill.trim()).filter(Boolean);
  if (skills?.length && !sandbox) throw new Error('Skills require CONTEXO_SANDBOX.');
  const runtime = sandbox ? { sandbox, skills } : undefined;
  const steps = await createAdmin(baseUrl.toString()).register({ port, token, primaryModel, fallbackModel, instructions, runtime });
  for (const step of steps) {
    const message = step.label + (step.detail ? ' — ' + step.detail : '');
    if (step.ok) console.log(message);
    else console.error(message);
  }
  if (steps.some(step => !step.ok)) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Registration failed');
  process.exitCode = 1;
});
