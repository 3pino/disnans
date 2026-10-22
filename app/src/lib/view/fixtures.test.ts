// 表示データの固定値（fixture）を確かめる。fixture 本体は crates/client-core/tests/fixtures/view/*.json にあり、
// Rust の cargo test（view_fixtures.rs）が木の値を、ここが TS の部品（メンションの名前・続きの判定）を確かめる。
// Markdown の解析は Rust だけが持つので、ここでは fixture の木の形が描画の部品（型）と合うかを見る（段 A）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mentionsToText } from '../markdown';
import { bodyToDraft, draftToBody } from '../mentions';
import { GROUP_MS, isContinuation, type RowLike } from '../messageRows';
import type { User } from '../protocol/User';

const DIR = fileURLToPath(new URL('../../../../crates/client-core/tests/fixtures/view/', import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${DIR}${name}`, 'utf8')) as T;

type MdFixture = {
  inline: { name: string; input: string; expected: unknown }[];
  blocks: { name: string; input: string; expected: unknown }[];
  mentionsToText: { name: string; body: string; names: Record<string, string>; expected: string }[];
};

/** 描画の部品（InlineNodes・Markdown）が扱う節の型と、その必要なキー。fixture の木がこれに合うかを見る */
const INLINE_KEYS: Record<string, string[]> = {
  text: ['text'],
  bold: ['children'],
  italic: ['children'],
  underline: ['children'],
  strike: ['children'],
  highlight: ['children'],
  code: ['text'],
  link: ['href', 'text'],
  fileLink: ['path', 'alias', 'embed'],
  mention: ['userId'],
};
const BLOCK_KEYS: Record<string, string[]> = {
  paragraph: ['lines'],
  code: ['lang', 'text'],
  quote: ['children'],
  list: ['ordered', 'start', 'items'],
};

function checkInline(n: Record<string, unknown>, where: string): void {
  const keys = INLINE_KEYS[String(n.type)];
  expect(keys, `${where}: unknown inline type ${String(n.type)}`).toBeDefined();
  for (const k of keys) expect(n, `${where}: ${String(n.type)} lacks ${k}`).toHaveProperty(k);
  if (Array.isArray(n.children)) (n.children as Record<string, unknown>[]).forEach((c) => checkInline(c, where));
}

function checkBlocks(list: unknown[], where: string): void {
  for (const raw of list) {
    const b = raw as Record<string, unknown>;
    const keys = BLOCK_KEYS[String(b.type)];
    expect(keys, `${where}: unknown block type ${String(b.type)}`).toBeDefined();
    for (const k of keys) expect(b, `${where}: ${String(b.type)} lacks ${k}`).toHaveProperty(k);
    if (b.type === 'paragraph') (b.lines as Record<string, unknown>[][]).forEach((line) => line.forEach((n) => checkInline(n, where)));
    if (b.type === 'quote') checkBlocks(b.children as unknown[], where);
    if (b.type === 'list') {
      for (const item of b.items as { lines: Record<string, unknown>[][]; children: unknown[] }[]) {
        item.lines.forEach((line) => line.forEach((n) => checkInline(n, where)));
        checkBlocks(item.children, where);
      }
    }
  }
}

describe('fixtures (V0/V3): markdown', () => {
  const md = load<MdFixture>('markdown.json');
  it.each(md.inline.map((c) => [c.name, c] as const))('inline %s has renderable nodes', (_name, c) => {
    (c.expected as Record<string, unknown>[]).forEach((n) => checkInline(n, c.name));
  });
  it.each(md.blocks.map((c) => [c.name, c] as const))('block %s has renderable nodes', (_name, c) => {
    checkBlocks(c.expected as unknown[], c.name);
  });
  it.each(md.mentionsToText.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(mentionsToText(c.body, (id) => c.names[id] ?? id)).toBe(c.expected);
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
