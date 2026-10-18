// ユーザー共通の設定（prefs）の読み方を、TS の normalize* が fixture どおりに返すことを確かめる（V5）。
// fixture: crates/client-core/tests/fixtures/prefs/user_prefs.json（Rust の tests/prefs_fixtures.rs も読む）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeHotkeys } from './commands.svelte';
import { DEFAULT_ENTER_KEYS, normalizeEnterKeys } from './enterKeys';
import { DEFAULT_COMPOSER_MENU, normalizeComposerMenu } from './composerMenu';
import { DEFAULT_MESSAGE_LAYOUT, normalizeMessageLayout } from './messageLayout';
import { normalizeSlashAliases } from './slashAlias';
import { DEFAULT_NAV_ITEMS, normalizeNavItems } from './navBar';
import { DEFAULT_CALL_SETTINGS } from './call/pure';
import { DEFAULT_ORIENTATION } from './orientation';

const FILE = fileURLToPath(new URL('../../../crates/client-core/tests/fixtures/prefs/user_prefs.json', import.meta.url));

type Case = { key: string; name: string; input: unknown; expected: unknown };

const READERS: Record<string, (raw: unknown) => unknown> = {
  hotkeys: normalizeHotkeys,
  slashNames: normalizeSlashAliases,
  enterKeys: normalizeEnterKeys,
  composerMenu: normalizeComposerMenu,
  messageLayout: normalizeMessageLayout,
  navBarItems: normalizeNavItems,
};

const cases = (JSON.parse(readFileSync(FILE, 'utf8')) as { cases: Case[] }).cases;

describe('fixtures (V5): user prefs', () => {
  it.each(cases.map((c) => [`${c.key} / ${c.name}`, c] as const))('%s', (_name, c) => {
    const read = READERS[c.key];
    expect(read, `reader for ${c.key}`).toBeTypeOf('function');
    expect(read(c.input)).toEqual(c.expected);
  });
});

describe('fixtures (V5): defaults', () => {
  const file = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/client-core/tests/fixtures/prefs/defaults.json', import.meta.url)), 'utf8')) as {
    defaults: Record<string, unknown>;
  };
  const d = file.defaults;
  it('call settings', () => {
    expect({
      joinMuted: DEFAULT_CALL_SETTINGS.joinMuted,
      micVolume: DEFAULT_CALL_SETTINGS.micVolume,
      outVolume: DEFAULT_CALL_SETTINGS.outVolume,
      limiter: DEFAULT_CALL_SETTINGS.limiter,
      limitDb: DEFAULT_CALL_SETTINGS.limitDb,
      inputId: DEFAULT_CALL_SETTINGS.inputId,
      output: DEFAULT_CALL_SETTINGS.output,
    }).toEqual({
      joinMuted: d.joinMuted,
      micVolume: d.micVolume,
      outVolume: d.outVolume,
      limiter: d.limiter,
      limitDb: d.limitDb,
      inputId: d.inputId,
      output: d.output,
    });
  });
  it('enter keys, composer menu, message layout, nav items, orientation', () => {
    expect(DEFAULT_ENTER_KEYS).toEqual(d.enterKeys);
    expect(DEFAULT_COMPOSER_MENU).toEqual(d.composerMenu);
    expect(DEFAULT_MESSAGE_LAYOUT).toBe(d.messageLayout);
    expect(DEFAULT_NAV_ITEMS).toEqual(d.navBarItems);
    expect(DEFAULT_ORIENTATION).toBe(d.orientation);
  });
});
