import { describe, expect, it } from 'vitest';
import { classifyDetailed, explainModelError } from '../src/run/fallback';

describe('explainModelError', () => {
  it('explains a model without tool support (real OpenRouter text)', () => {
    const raw = '[Model Error] Request failed (404): No endpoints found that support tool use. Try disabling "ask_user_question". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection';
    expect(explainModelError(raw)).toMatch(/does not support tool calling/);
  });

  it('explains rate limits, credits and unknown models; leaves clear auth errors as they are', () => {
    expect(explainModelError('[Model Error] Request failed (401): Invalid API key')).toBeUndefined();
    expect(explainModelError('[Model Error] Request failed (429): Rate limit exceeded')).toMatch(/rate-limiting/);
    expect(explainModelError('[Model Error] Request failed (402): Insufficient credits')).toMatch(/no credits/);
    expect(explainModelError('[Model Error] model "foo/bar" not found')).toMatch(/does not know this model/);
  });

  it('leaves other messages alone', () => {
    expect(explainModelError('[Model Error] Cannot connect to API: bad port')).toBeUndefined();
  });

  it('is used as the reason for a failed turn, and it is still a model failure', () => {
    const c = classifyDetailed({
      type: 'turn.done',
      state: { status: 'error', message: '[Model Error] Request failed (404): No endpoints found that support tool use.' },
    });
    expect(c.kind).toBe('model-failure');
    expect(c.reason).toMatch(/does not support tool calling/);
  });
});
