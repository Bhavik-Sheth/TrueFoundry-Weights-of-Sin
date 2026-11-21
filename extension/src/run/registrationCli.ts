import { createAdmin, type GitSkill } from './trueforgeAdmin';
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
  const output = process.env.CONTEXO_MODEL_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = output === undefined ? undefined : Number(output);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 32768)) {
    throw new Error('CONTEXO_MODEL_MAX_OUTPUT_TOKENS must be an integer between 256 and 32768.');
  }
  const ref = process.env.CONTEXO_REVIEW_SKILL_SHA;
  let gitSkill: GitSkill | undefined;
  if (ref) {
    if (!sandbox || !/^[a-f0-9]{40}$/i.test(ref)) throw new Error('A pinned 40-character skill commit and a ready sandbox are required.');
    gitSkill = { type: 'git', name: 'contexo-review', ref, path: 'extension/skills/contexo-review',
      url: 'https://github.com/Bhavik-Sheth/TrueFoundry-Weights-of-Sin',
      description: 'Gather workspace evidence and stage reviewable source edits through Contexo.' };
  }
  const skillNames = [...new Set([...(skills ?? []), ...(gitSkill ? [gitSkill.name] : [])])];
  const runtime = sandbox || maxOutputTokens ? { sandbox, skills: skillNames, maxOutputTokens } : undefined;
  const steps = await createAdmin(baseUrl.toString()).register({
    port, token, primaryModel, fallbackModel, instructions, runtime, gitSkill,
    rotateToken: process.env.CONTEXO_ROTATE_TOKEN === '1',
  });
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
