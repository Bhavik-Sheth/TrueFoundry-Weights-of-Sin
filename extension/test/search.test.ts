import { describe, expect, it } from 'vitest';
import { Bm25, resolveRgPath, symbolNameMatch, tokenize } from '../src/context/search';
import type { SymbolEntry } from '../src/types';

describe('tokenize', () => {
  it('splits snake_case and camelCase and keeps the whole identifier', () => {
    expect(tokenize('load_config')).toEqual(['load_config', 'load', 'config']);
    expect(tokenize('FlaskGroupCli')).toEqual(['flaskgroupcli', 'flask', 'group', 'cli']);
  });
  it('drops stopwords and 1-char tokens', () => {
    expect(tokenize('the x of command')).toEqual(['command']);
  });
});

describe('Bm25', () => {
  const docs = [
    { id: 'cli', text: 'def run_command(): click command group for the flask cli command' },
    { id: 'cfg', text: 'class Config: loads configuration from files and environment' },
    { id: 'misc', text: 'helper utilities for strings' },
  ];
  it('ranks the relevant doc first', () => {
    const r = new Bm25(docs).rank(['command', 'cli']);
    expect(r[0].id).toBe('cli');
    expect(r.map((x) => x.id)).not.toContain('misc');
  });
  it('honours k', () => {
    expect(new Bm25(docs).rank(['config', 'command'], 1)).toHaveLength(1);
  });
});

describe('symbolNameMatch', () => {
  const sym = (name: string): SymbolEntry => ({ id: `p#${name}`, path: 'p', name, qualifiedName: name, kind: 'function', startLine: 1, endLine: 2, decorators: [], calls: [], imports: [], text: '' });
  it('scores exact 3, prefix 2, contains 1', () => {
    const r = symbolNameMatch(['config'], [sym('my_config'), sym('config_loader'), sym('Config'), sym('other')]);
    expect(r.map((x) => [x.symbol.name, x.score])).toEqual([['Config', 3], ['config_loader', 2], ['my_config', 1]]);
  });
});

describe('resolveRgPath', () => {
  it('falls back to rg on PATH without a bundled binary', () => {
    expect(resolveRgPath('/nonexistent')).toBe('rg');
    expect(resolveRgPath()).toBe('rg');
  });
});
