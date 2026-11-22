/**
 * MentionPopover.tsx - @ mention completion for the chat send box.
 *
 * Exports:
 *  - useMentions(text, caret, setText): setText(newText, newCaret) is called on insert; detects an `@token` (>= 2 non-space chars) before the caret, posts a
 *    debounced {type:'mentionQuery'}, ignores stale mentionResults, and returns { popover, onKeyDown } where
 *    onKeyDown handles ArrowUp/ArrowDown/Enter/Tab (insert) and Escape (close) and returns true when it consumed the key.
 *
 * Depends on: bridge.ts, types.ts. Depended on by: App.tsx.
 */
import { createElement, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { post, subscribe } from './bridge';
import type { MentionItem } from '../../src/types';

const TOKEN = /(?:^|\s)@(\S{2,})$/;

export function useMentions(text: string, caret: number, setText: (t: string, caret: number) => void) {
  const q = TOKEN.exec(text.slice(0, caret))?.[1] ?? '';
  const [res, setRes] = useState<{ q: string; items: MentionItem[] }>({ q: '', items: [] });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');

  useEffect(() => subscribe((m) => { if (m.type === 'mentionResults') { setRes({ q: m.q, items: m.items }); setActive(0); } }), []);
  useEffect(() => {
    if (!q) return;
    const t = setTimeout(() => post({ type: 'mentionQuery', q }), 120);
    return () => clearTimeout(t);
  }, [q]);

  const items = q && res.q === q && dismissed !== q ? res.items : [];
  const insert = (item: MentionItem) => {
    const head = text.slice(0, caret).replace(/@\S+$/, item.insert + ' ');
    setText(head + text.slice(caret), head.length);
  };
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown') setActive((active + 1) % items.length);
    else if (e.key === 'ArrowUp') setActive((active - 1 + items.length) % items.length);
    else if (e.key === 'Enter' || e.key === 'Tab') insert(items[active]);
    else if (e.key === 'Escape') setDismissed(q);
    else return false;
    e.preventDefault();
    return true;
  };
  const popover = items.length ? createElement('ul', { className: 'mention-popover', role: 'listbox', 'aria-label': 'Mention suggestions' },
    items.map((item, i) => createElement('li', {
      key: item.insert + i, role: 'option', 'aria-selected': i === active, className: i === active ? 'active' : undefined,
      onMouseDown: (e: { preventDefault(): void }) => { e.preventDefault(); insert(item); },
    }, createElement('span', { className: 'mention-label' }, item.label), createElement('span', { className: 'mention-detail' }, item.detail)))) : null;
  return { popover, onKeyDown };
}
