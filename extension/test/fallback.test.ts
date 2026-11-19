/**
 * fallback.test.ts - classify / classifyDetailed on representative payloads (shapes from the SDK types).
 */
import { describe, expect, it } from 'vitest';
import { classify, classifyDetailed } from '../src/run/fallback';

const sdkErr = (statusCode: number) => Object.assign(new Error(`Status code: ${statusCode}`), { name: 'TrueForgeError', statusCode });
const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code }) });
const done = (status: string, message?: string) => ({ type: 'turn.done', state: { status, message } });

describe('classify', () => {
  it.each([401, 403, 404, 408, 429, 500, 502, 503])('SDK error %i -> model-failure', (s) => {
    expect(classify(sdkErr(s))).toBe('model-failure');
  });
  it('400 -> other', () => expect(classify(sdkErr(400))).toBe('other'));
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'])('%s in cause chain -> model-failure', (c) => {
    expect(classify(netErr(c))).toBe('model-failure');
  });
  it("bare 'fetch failed' -> model-failure", () => expect(classify(new TypeError('fetch failed'))).toBe('model-failure'));
  it('SDK timeout error -> model-failure', () => {
    expect(classify(Object.assign(new Error('Timeout exceeded'), { name: 'TrueForgeTimeoutError' }))).toBe('model-failure');
  });
  it('turn.done error with Invalid API key -> model-failure', () => {
    const c = classifyDetailed(done('error', 'Invalid API key provided'));
    expect(c).toMatchObject({ kind: 'model-failure', trueforgeDown: false });
    expect(c.reason).toContain('Invalid API key');
  });
  it('turn.done error with unrelated text -> other', () => expect(classify(done('error', 'turn error'))).toBe('other'));
  it('turn.done cancelled -> cancelled', () => expect(classify(done('cancelled'))).toBe('cancelled'));
  it('AbortError -> cancelled', () => expect(classify(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('cancelled'));
  it('tool error -> other', () => {
    expect(classify({ type: 'tool.response', toolCallId: 't', content: 'ERROR: 500 from tool' })).toBe('other');
    expect(classify(new Error('tool blew up'))).toBe('other');
  });
  it('null/unknown -> other', () => {
    expect(classify(undefined)).toBe('other');
    expect(classify('weird')).toBe('other');
  });
});

describe('trueforgeDown', () => {
  it('thrown network error before model activity -> true', () => {
    expect(classifyDetailed(netErr('ECONNREFUSED'))).toMatchObject({ kind: 'model-failure', trueforgeDown: true, reason: 'ECONNREFUSED' });
  });
  it('after model activity -> false', () => {
    expect(classifyDetailed(netErr('ECONNRESET'), { sawActivity: true }).trueforgeDown).toBe(false);
  });
  it('HTTP errors and turn.done errors are never trueforgeDown', () => {
    expect(classifyDetailed(sdkErr(502)).trueforgeDown).toBe(false);
    expect(classifyDetailed(done('error', 'ECONNREFUSED 127.0.0.1:9')).trueforgeDown).toBe(false);
  });
});
