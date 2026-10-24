// 補完の規則の fixture（crates/client-core/tests/fixtures/suggest/*.json）。GUI の providers がこれを通ることを見る。
// 同じ fixture を Rust（core の view::suggest と TUI）も読む。両方が通れば、GUI・TUI の規則は揃っている。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SlashCommandDef } from '../slashCommands.svelte';
import type { User } from '../protocol/User';
import { findSuggestion } from './index';
import { mentionProvider } from './mention';
import { emojiProvider } from './emoji';
import { slashProvider } from './slash';
import type { SuggestProvider } from './types';

const DIR = fileURLToPath(new URL('../../../../crates/client-core/tests/fixtures/suggest/', import.meta.url));

export type Expected = {
  kind: 'mention' | 'emoji' | 'slash';
  /** 置き換える部分（キャレットより前の末尾の文字列） */
  replaced: string;
  query: string;
  items: { key: string; title: string; insert: string }[];
};

export type Fixture = {
  schema: number;
  note: string;
  members?: { id: string; display_name: string; login_name: string }[];
  commands?: { name: string; description: string }[];
  cases: { name: string; before: string; expected: Expected | null }[];
};

const KIND_OF_LABEL: Record<string, Expected['kind']> = { コマンド: 'slash', メンション: 'mention', 絵文字: 'emoji' };

/** GUI（MessageInput と同じ順の providers）が、キャレット（文字列の末尾）で出す候補 */
export function guiSuggest(f: Fixture, before: string): Expected | null {
  const members: User[] = (f.members ?? []).map((m) => ({
    id: m.id,
    display_name: m.display_name,
    login_name: m.login_name,
    avatar_url: null,
    created_at: 0,
  }));
  const commands = (f.commands ?? []).map(
    (c) => ({ name: c.name, description: c.description, run: () => {} }) as SlashCommandDef,
  );
  const providers: SuggestProvider[] = [
    slashProvider(() => commands),
    mentionProvider(
      () => members,
      () => {},
    ),
    emojiProvider(),
  ];
  const s = findSuggestion(providers, before, before.length);
  if (!s) return null;
  return {
    kind: KIND_OF_LABEL[s.label],
    replaced: before.slice(s.start, s.end),
    query: s.query,
    items: s.items.map((i) => ({ key: i.key, title: i.title, insert: i.insert })),
  };
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('fixtures (batch 7): 補完の規則は GUI の結果と一致する', () => {
  it.each(files)('%s', (file) => {
    const f = JSON.parse(readFileSync(DIR + file, 'utf8')) as Fixture;
    expect(f.schema).toBe(1);
    expect(f.cases.length).toBeGreaterThan(0);
    for (const c of f.cases) {
      expect(guiSuggest(f, c.before), c.name).toEqual(c.expected);
    }
  });
});
