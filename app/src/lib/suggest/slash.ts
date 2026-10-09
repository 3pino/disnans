import type { SlashCommandDef } from '../slashCommands.svelte';
import { rankByName } from './index';
import type { SuggestItem, SuggestProvider } from './types';

/** 先頭の `/コマンド名 ` の部分。引数はそのあとから */
const HEAD_RE = /^\/([a-z0-9-]+)[ \t]+/;

function commandItem(c: SlashCommandDef): SuggestItem {
  const detail = [c.args, c.description, c.source && `（${c.source}）`].filter(Boolean).join(' ');
  return { key: c.name, title: '/' + c.name, detail, icon: c.icon, insert: `/${c.name} ` };
}

function argItems(c: SlashCommandDef, input: string): SuggestItem[] {
  if (!c.suggestArgs) return [];
  let list;
  try {
    list = c.suggestArgs(input);
  } catch (e) {
    // プラグインの不具合で入力欄を壊さない
    console.error(`/${c.name} の引数の候補を出せませんでした`, e);
    return [];
  }
  return list
    .filter((a) => a.value !== input)
    .slice(0, 8)
    .map((a) => ({ key: a.value, title: a.label ?? a.value, detail: a.description, insert: a.value }));
}

/**
 * 入力欄の先頭の `/` でコマンドを出す。
 * コマンド名のあとは、コマンドに suggestArgs があれば引数の候補を出す（打っている引数全体を置き換える）
 */
export function slashProvider(commands: () => SlashCommandDef[]): SuggestProvider {
  return {
    label: 'コマンド',
    match(text, caret) {
      const before = text.slice(0, caret);
      const name = /^\/([a-z0-9-]*)$/.exec(before);
      if (name) return { start: 0, end: caret, query: name[1] };
      const head = HEAD_RE.exec(before);
      if (head && !before.includes('\n')) return { start: head[0].length, end: caret, query: before.slice(head[0].length) };
      return null;
    },
    items(text, range) {
      const list = commands();
      if (range.start === 0) {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        return rankByName(sorted, (c) => [c.name], range.query).map(commandItem);
      }
      const name = HEAD_RE.exec(text)![1];
      const c = list.find((x) => x.name === name);
      return c ? argItems(c, range.query) : [];
    },
  };
}

/** 入力が `/コマンド名 ` で始まるとき、そのコマンド（引数の書き方のヒントに使う） */
export function commandHint(text: string, commands: SlashCommandDef[]): SlashCommandDef | null {
  const head = HEAD_RE.exec(text);
  if (!head) return null;
  return commands.find((c) => c.name === head[1]) ?? null;
}
