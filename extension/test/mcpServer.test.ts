import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { capOutput, resolveUnder } from '../src/mcp/server';

describe('capOutput', () => {
  it('passes short text through', () => {
    expect(capOutput('hello')).toEqual({ text: 'hello', truncated: false });
  });
  it('truncates at the default 16000 chars', () => {
    const r = capOutput('x'.repeat(20000));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(16000);
  });
  it('honours a custom max and exact-length input', () => {
    expect(capOutput('abcd', 4).truncated).toBe(false);
    expect(capOutput('abcde', 4)).toEqual({ text: 'abcd', truncated: true });
  });
});

describe('resolveUnder', () => {
  const root = path.resolve('/ws/project');
  it('resolves a relative path inside the root', () => {
    expect(resolveUnder(root, 'src/flask/cli.py')).toBe(path.join(root, 'src', 'flask', 'cli.py'));
  });
  it('rejects absolute paths', () => {
    expect(() => resolveUnder(root, '/etc/passwd')).toThrow(/absolute/);
    expect(() => resolveUnder(root, 'C:\\Windows\\win.ini')).toThrow(/absolute/);
  });
  it('rejects .. escapes', () => {
    expect(() => resolveUnder(root, '../secret')).toThrow(/\.\./);
    expect(() => resolveUnder(root, 'a/../../b')).toThrow();
    expect(() => resolveUnder(root, 'a\\..\\b')).toThrow();
  });
  it('rejects .git segments', () => {
    expect(() => resolveUnder(root, '.git/config')).toThrow(/\.git/);
    expect(() => resolveUnder(root, 'sub/.git/HEAD')).toThrow(/\.git/);
  });
  it('allows names that merely contain .git', () => {
    expect(resolveUnder(root, '.gitignore')).toBe(path.join(root, '.gitignore'));
  });
  it('rejects empty path', () => {
    expect(() => resolveUnder(root, '')).toThrow();
  });
});
