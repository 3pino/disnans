// 表示データの固定値（fixture）を、TS の現在の実装が通すことを確かめる（V0）。
// fixture 本体は crates/client-core/tests/fixtures/view/*.json にあり、Rust の cargo test も同じファイルを読む（V2 以降）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractMentions, mentionsToText, parse, parseInline } from '../markdown';
import { bodyToDraft, draftToBody } from '../mentions';
import { GROUP_MS, isContinuation, type RowLike } from '../messageRows';
import type { User } from '../protocol/User';

const DIR = fileURLToPath(new URL('../../../../crates/client-core/tests/fixtures/view/', import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;

type MdFixture = {
  inline: { name: string; input: string; expected: unknown }[];
  blocks: { name: string; input: string; expected: unknown }[];
  mentionsToText: { name: string; body: string; names: Record<string, string>; expected: string }[];
  extractMentions: { name: string; body: string; expected: string[] }[];
};

describe('fixtures (V0): markdown', () => {
  const md = load<MdFixture>('markdown.json');
  it.each(md.inline.map((c) => [c.name, c] as const))('inline %s', (_name, c) => {
    expect(parseInline(c.input)).toEqual(c.expected);
  });
  it.each(md.blocks.map((c) => [c.name, c] as const))('block %s', (_name, c) => {
    expect(parse(c.input)).toEqual(c.expected);
  });
  it.each(md.mentionsToText.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(mentionsToText(c.body, (id) => c.names[id] ?? id)).toBe(c.expected);
  });
  it.each(md.extractMentions.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(extractMentions(c.body)).toEqual(c.expected);
  });
});

describe('fixtures (V0): mentions (composer)', () => {
  type MFixture = {
    cases: { name: string; users: Record<string, string>; body: string; draft: string; draftMap: [string, string][]; roundTrip: string }[];
  };
  const f = load<MFixture>('mentions.json');
  it.each(f.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const users = Object.fromEntries(
      Object.entries(c.users).map(([id, name]) => [id, { id, display_name: name, login_name: id } as User]),
    );
    const map = new Map<string, string>();
    expect(bodyToDraft(c.body, users, map)).toBe(c.draft);
    expect([...map.entries()]).toEqual(c.draftMap);
    expect(draftToBody(c.draft, map)).toBe(c.roundTrip);
  });
});

describe('fixtures (V0): continuation (grouping)', () => {
  type CFixture = {
    groupMs: number;
    cases: { name: string; prev: RowLike | null; cur: RowLike; newDay: boolean; expected: boolean }[];
  };
  const f = load<CFixture>('continuation.json');
  it('the group window in the fixture is the TS constant', () => {
    expect(f.groupMs).toBe(GROUP_MS);
  });
  it.each(f.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(isContinuation(c.prev, c.cur, c.newDay)).toBe(c.expected);
  });
});
