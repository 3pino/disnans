import { describe, expect, it } from 'vitest';
import { applySuggestion, findSuggestion, rankByName, tokenBefore } from './index';
import { mentionProvider } from './mention';
import { emojiProvider } from './emoji';
import { commandHint, slashProvider } from './slash';
import type { SlashCommandDef } from '../slashCommands.svelte';
import type { User } from '../protocol/User';

const u = (id: string, name: string): User => ({ id, login_name: id + '@x', display_name: name, avatar_url: null, created_at: 0 });
const cmd = (name: string, extra: Partial<SlashCommandDef> = {}): SlashCommandDef => ({
  name,
  description: name + ' の説明',
  run: () => {},
  ...extra,
});

describe('tokenBefore', () => {
  it('finds token after a boundary', () => {
    expect(tokenBefore('hi :smi', 7, ':', '[a-z]')).toEqual({ start: 3, query: 'smi' });
    expect(tokenBefore('(:ab', 4, ':', '[a-z]')).toEqual({ start: 1, query: 'ab' });
    expect(tokenBefore('12:30', 5, ':', '[0-9]')).toBeNull();
  });

  it('respects min length', () => {
    expect(tokenBefore(':a', 2, ':', '[a-z]', { min: 2 })).toBeNull();
    expect(tokenBefore(':ab', 3, ':', '[a-z]', { min: 2 })).toEqual({ start: 0, query: 'ab' });
  });
});

describe('rankByName', () => {
  it('prefix first, then substring', () => {
    const list = ['xab', 'abc', 'zzz', 'ab'];
    expect(rankByName(list, (s) => [s], 'ab')).toEqual(['abc', 'ab', 'xab']);
    expect(rankByName(list, (s) => [s], '', 2)).toEqual(['xab', 'abc']);
  });
});

describe('applySuggestion', () => {
  it('replaces the range and moves the caret', () => {
    expect(applySuggestion('hi @al there', { start: 3, end: 6 }, '@Alice ')).toEqual({ text: 'hi @Alice  there', caret: 10 });
  });
});

describe('mention provider', () => {
  it('suggests users and reports the pick', () => {
    const picked: string[] = [];
    const p = mentionProvider(
      () => [u('1', 'Bob'), u('2', 'alice')],
      (x) => picked.push(x.id),
    );
    const s = findSuggestion([p], 'hey @al', 7)!;
    expect(s).toMatchObject({ start: 4, end: 7, label: 'メンション' });
    expect(s.items.map((i) => i.insert)).toEqual(['@alice ']);
    s.items[0].picked?.();
    expect(picked).toEqual(['2']);
  });
});

describe('emoji provider', () => {
  const p = emojiProvider();

  it('needs two letters', () => {
    expect(findSuggestion([p], ':s', 2)).toBeNull();
    expect(findSuggestion([p], 'at 10:30', 8)).toBeNull();
  });

  it('suggests by short code', () => {
    const s = findSuggestion([p], 'hi :thu', 7)!;
    expect(s.start).toBe(3);
    expect(s.items[0]).toMatchObject({ emoji: '👍', insert: '👍', title: ':thumbsup:' });
  });

  it('shows the matched alias', () => {
    const s = findSuggestion([p], ':sak', 4)!;
    expect(s.items[0]).toMatchObject({ emoji: '🌸', title: ':sakura:' });
  });
});

describe('slash provider', () => {
  const list = [
    cmd('thread', { args: '<本文>' }),
    cmd('dice', { source: 'dice', suggestArgs: (input) => ['d6', 'd20'].filter((v) => v.startsWith(input)).map((value) => ({ value })) }),
  ];
  const p = slashProvider(() => list);

  it('suggests commands only at the start', () => {
    const s = findSuggestion([p], '/', 1)!;
    expect(s.items.map((i) => i.title)).toEqual(['/dice', '/thread']);
    expect(findSuggestion([p], '/th', 3)!.items.map((i) => i.insert)).toEqual(['/thread ']);
    expect(findSuggestion([p], 'a /th', 5)).toBeNull();
    expect(findSuggestion([p], '//', 2)).toBeNull();
  });

  it('shows args and source in the detail', () => {
    const s = findSuggestion([p], '/', 1)!;
    expect(s.items[0].detail).toBe('dice の説明 （dice）');
    expect(s.items[1].detail).toBe('<本文> thread の説明');
  });

  it('suggests args after the command name', () => {
    const s = findSuggestion([p], '/dice d', 7)!;
    expect(s).toMatchObject({ start: 6, end: 7, query: 'd' });
    expect(s.items.map((i) => i.insert)).toEqual(['d6', 'd20']);
    // 打ち終えた候補は出さない
    expect(findSuggestion([p], '/dice d20', 9)).toBeNull();
    // suggestArgs が無いコマンドは出さない
    expect(findSuggestion([p], '/thread ', 8)).toBeNull();
  });

  it('survives a throwing suggestArgs', () => {
    const bad = slashProvider(() => [
      cmd('bad', {
        suggestArgs: () => {
          throw new Error('x');
        },
      }),
    ]);
    const orig = console.error;
    console.error = () => {};
    expect(findSuggestion([bad], '/bad ', 5)).toBeNull();
    console.error = orig;
  });

  it('hint', () => {
    expect(commandHint('/thread ', list)?.name).toBe('thread');
    expect(commandHint('/thread', list)).toBeNull();
    expect(commandHint('/nope x', list)).toBeNull();
  });
});
