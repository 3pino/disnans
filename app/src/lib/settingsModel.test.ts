import { describe, expect, it } from 'vitest';
import { DEVICE_DEFAULTS, LEGACY, legacyDeviceValues, legacyUserValues, normalizeDevicePrefs, normalizeTheme } from './settingsModel';

/** 手元の localStorage の代わり */
function store(entries: Record<string, string>) {
  return (key: string) => (key in entries ? entries[key] : null);
}

describe('legacyUserValues（以前の localStorage からユーザーごとの値）', () => {
  it('テーマ・選んだテーマ・ナビの項目と表示名を読む', () => {
    const v = legacyUserValues(
      store({
        [LEGACY.theme]: 'dark',
        [LEGACY.customTheme]: 'midnight',
        [LEGACY.navBarItems]: JSON.stringify(['app:open-settings', 'chat', 'settings']),
        [LEGACY.navBarLabels]: JSON.stringify({ chat: 'ホーム', x: 3 }),
      }),
    );
    expect(v.theme).toBe('dark');
    expect(v.customTheme).toBe('midnight');
    expect(v.navBarItems).toEqual(expect.arrayContaining(['chat', 'settings']));
    expect(v.navBarLabels).toEqual({ chat: 'ホーム' });
  });

  it('何も無ければ空（既定はサーバーの側に任せる）', () => {
    expect(legacyUserValues(store({}))).toEqual({});
  });

  it('知らないテーマは入れない', () => {
    expect(legacyUserValues(store({ [LEGACY.theme]: 'pink' }))).toEqual({});
  });

  it('通話の値は、ユーザーごとのものだけ（範囲に収める）', () => {
    const v = legacyUserValues(store({ [LEGACY.call]: JSON.stringify({ joinMuted: true, micVolume: 9, limitDb: -100, inputId: 'mic1', output: null }) }));
    expect(v).toEqual({ joinMuted: true, micVolume: 2, limitDb: -18 });
    expect(v).not.toHaveProperty('inputId');
  });

  it('通話の旧い保存先（voice）は、新しいものが無いときだけ引き継ぐ', () => {
    const old = store({ [LEGACY.callVoice]: JSON.stringify({ limiter: false }) });
    expect(legacyUserValues(old)).toEqual({ limiter: false });
    const both = store({ [LEGACY.call]: JSON.stringify({ limiter: true }), [LEGACY.callVoice]: JSON.stringify({ limiter: false }) });
    expect(legacyUserValues(both)).toEqual({ limiter: true });
  });
});

describe('legacyDeviceValues（以前の localStorage から端末ごとの値）', () => {
  it('ナビバーを隠す（"1" を真偽値に）・向き・端末の種類・プラグイン', () => {
    const v = legacyDeviceValues(
      store({
        [LEGACY.hideNavigationBar]: '1',
        [LEGACY.orientation]: 'media',
        [LEGACY.deviceKind]: 'tablet',
        [LEGACY.pluginsDisabled]: JSON.stringify(['dice', 3]),
        [LEGACY.pluginsDevDir]: '  /home/me/plugins ',
      }),
    );
    expect(v).toEqual({
      hideNavigationBar: true,
      orientation: 'media',
      deviceKind: 'tablet',
      pluginsDisabled: ['dice'],
      pluginsDevDir: '/home/me/plugins',
    });
  });

  it('"1" 以外は偽、知らない値は入れない', () => {
    const v = legacyDeviceValues(store({ [LEGACY.hideNavigationBar]: '0', [LEGACY.deviceKind]: 'phone' }));
    expect(v).toEqual({ hideNavigationBar: false });
  });

  it('通話の機器（入力・出力）は端末ごと', () => {
    const v = legacyDeviceValues(store({ [LEGACY.call]: JSON.stringify({ inputId: 'mic1', output: { id: 'o', kind: 'speaker', label: 'S' } }) }));
    expect(v).toEqual({ inputId: 'mic1', output: { id: 'o', kind: 'speaker', label: 'S' } });
  });
});

describe('normalizeDevicePrefs', () => {
  it('足りないものは既定、型の合わないものは既定に戻す。知らない項目は残す', () => {
    const n = normalizeDevicePrefs({ hideNavigationBar: 'yes', orientation: 'sideways', deviceKind: 'phone', pluginsDisabled: 'x', extra: 1 });
    expect(n).toEqual({ ...DEVICE_DEFAULTS, extra: 1 });
  });

  it('オブジェクトでなければ既定', () => {
    expect(normalizeDevicePrefs(null)).toEqual({ ...DEVICE_DEFAULTS });
    expect(normalizeDevicePrefs('x')).toEqual({ ...DEVICE_DEFAULTS });
  });

  it('正しい値はそのまま', () => {
    const n = normalizeDevicePrefs({ deviceKind: 'laptop', orientation: 'portrait', pluginsDisabled: ['a'], pluginsDevDir: '/x', output: { id: 'o' }, inputId: 'm' });
    expect(n).toMatchObject({ deviceKind: 'laptop', orientation: 'portrait', pluginsDisabled: ['a'], pluginsDevDir: '/x', output: { id: 'o' }, inputId: 'm' });
  });
});

describe('normalizeTheme', () => {
  it('system・light・dark だけ通す', () => {
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('blue')).toBe('system');
    expect(normalizeTheme(undefined)).toBe('system');
  });
});

// ---- 既定値が Rust の定義（tests/fixtures/prefs/defaults.json）と同じか ----
// 既定値の固定は fixture が正（Rust の defaults_match_the_fixture も同じファイルを読む）。
// TS の既定（ここの DEVICE_DEFAULTS・各モジュールの DEFAULT_*）が、その値と一致することを確かめる。
// 区分（ユーザー共通・端末ごと・ローカル）は fixture に無いので、下の表で TS 側の区分と合わせる。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CALL_SETTINGS } from './call/pure';
import { DEFAULT_NAV_ITEMS } from './navBar';
import { DEFAULT_ENTER_KEYS } from './enterKeys';
import { DEFAULT_COMPOSER_MENU } from './composerMenu';
import { DEFAULT_MESSAGE_LAYOUT } from './messageLayout';
import { DEFAULT_ORIENTATION } from './orientation';
import { USER_KEYS, DEVICE_KEYS } from './settingsModel';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../crates/client-core/tests/fixtures/prefs/defaults.json', import.meta.url)), 'utf8'),
) as { defaults: Record<string, unknown> };
const fixture = FIXTURE.defaults;

/** 区分（scope）ごとのキー。fixture の全項目を、どこか1つに分類する */
const SCOPE_OF: Record<string, 'user' | 'device' | 'local'> = {
  theme: 'user',
  customTheme: 'user',
  navBarItems: 'user',
  navBarLabels: 'user',
  joinMuted: 'user',
  micVolume: 'user',
  outVolume: 'user',
  limiter: 'user',
  limitDb: 'user',
  hotkeys: 'user',
  slashNames: 'user',
  enterKeys: 'user',
  composerMenu: 'user',
  messageLayout: 'user',
  inputId: 'device',
  output: 'device',
  deviceKind: 'device',
  hideNavigationBar: 'device',
  orientation: 'device',
  pluginsDisabled: 'device',
  pluginsDevDir: 'device',
  server: 'local',
  devUser: 'local',
  updateCheckedAt: 'local',
  updateNotifiedVersion: 'local',
};

/** TS 側の既定（同じ値を読む先）。ユーザー共通・端末ごと */
const TS_DEFAULTS: Record<string, unknown> = {
  theme: 'system',
  customTheme: null,
  navBarItems: DEFAULT_NAV_ITEMS,
  navBarLabels: {},
  joinMuted: DEFAULT_CALL_SETTINGS.joinMuted,
  micVolume: DEFAULT_CALL_SETTINGS.micVolume,
  outVolume: DEFAULT_CALL_SETTINGS.outVolume,
  limiter: DEFAULT_CALL_SETTINGS.limiter,
  limitDb: DEFAULT_CALL_SETTINGS.limitDb,
  hotkeys: {},
  slashNames: {},
  enterKeys: DEFAULT_ENTER_KEYS,
  composerMenu: DEFAULT_COMPOSER_MENU,
  messageLayout: DEFAULT_MESSAGE_LAYOUT,
  ...DEVICE_DEFAULTS,
  inputId: DEFAULT_CALL_SETTINGS.inputId,
  output: DEFAULT_CALL_SETTINGS.output,
  orientation: DEFAULT_ORIENTATION,
};

describe('既定値は fixture（Rust の定義と同じ）と一致する', () => {
  it('fixture の全項目に区分がある（足し忘れ・消し忘れの検出）', () => {
    expect(Object.keys(SCOPE_OF).sort()).toEqual(Object.keys(fixture).sort());
  });

  it('区分の表は、TS の一覧（USER_KEYS・DEVICE_KEYS）と一致する', () => {
    const user = Object.keys(SCOPE_OF).filter((k) => SCOPE_OF[k] === 'user');
    const device = Object.keys(SCOPE_OF).filter((k) => SCOPE_OF[k] === 'device');
    // prefs の中のキーは USER_KEYS（テーマ・ナビ・通話）と、ほかの prefs（ホットキーなど）に分かれる
    for (const k of USER_KEYS) expect(user, k).toContain(k);
    expect(device.sort()).toEqual([...DEVICE_KEYS].sort());
  });

  it.each(Object.keys(fixture).filter((k) => k in TS_DEFAULTS).map((k) => [k] as const))('%s', (key) => {
    expect(TS_DEFAULTS[key]).toEqual(fixture[key]);
  });

  it('TS の既定が、fixture のすべての項目を覆う（ローカル項目を除く）', () => {
    const missing = Object.keys(fixture).filter((k) => SCOPE_OF[k] !== 'local' && !(k in TS_DEFAULTS));
    expect(missing).toEqual([]);
  });
});
