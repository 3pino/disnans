// ステップ7 P0: デバイス分岐の特徴付けテスト（Tauri だけ。ブラウザー版は持たない）。
// いまの判定（UA・Tauri の注入）の結果を、環境ごとに固定する。
// この表が変わるなら、表を直す前に理由を書く。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsServerSetup } from './config';
import { isAndroid, isLinuxDesktop, isTauri } from './platform';
import { isDesktopStorageSupported } from './desktopStorage';
import { devFolderSupported } from './plugins/dev';
import { guessDeviceKind } from './deviceKind.svelte';
import { bootChatTransport, bootReadApi, bootWriteApi, currentBootEnv, currentChatBootEnv } from './transport/boot';
import { injectedPlatform, stubTauri, type TauriOs } from './testing/tauriEnv';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** 期待値の表: 環境ごとの 1 行。列は下の見出しの順 */
type Row = {
  os: TauriOs;
  isAndroid: boolean;
  isLinuxDesktop: boolean;
  sharedStorage: boolean; // isDesktopStorageSupported（Windows・Linux 以外の Tauri は false のまま。Android は true（step6 の (3)））
  devFolder: boolean;
  needsServerSetup: boolean;
  readApi: 'tauri' | 'http';
  writeApi: 'tauri' | 'http';
  writeMode: 'raw' | 'base64' | 'none';
  chat: 'rust' | 'none';
  deviceKindGuess: 'smartphone' | 'laptop';
};

// 現在の挙動。Windows・Linux・Android 以外の Tauri は shared storage と Rust の API（読取・書込）を使わず、チャットも無い（Q1 の判断）
const EXPECTED: Row[] = [
  { os: 'windows', isAndroid: false, isLinuxDesktop: false, sharedStorage: true, devFolder: true, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'raw', chat: 'rust', deviceKindGuess: 'laptop' },
  { os: 'linux', isAndroid: false, isLinuxDesktop: true, sharedStorage: true, devFolder: true, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'raw', chat: 'rust', deviceKindGuess: 'laptop' },
  { os: 'other', isAndroid: false, isLinuxDesktop: false, sharedStorage: false, devFolder: true, needsServerSetup: true, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'none', deviceKindGuess: 'laptop' },
  { os: 'android', isAndroid: true, isLinuxDesktop: false, sharedStorage: true, devFolder: false, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'base64', chat: 'rust', deviceKindGuess: 'smartphone' },
];

function assertRow(row: Row): void {
  expect(isTauri()).toBe(true);
  expect(isAndroid()).toBe(row.isAndroid);
  expect(isLinuxDesktop()).toBe(row.isLinuxDesktop);
  expect(isDesktopStorageSupported()).toBe(row.sharedStorage);
  expect(devFolderSupported()).toBe(row.devFolder);
  expect(needsServerSetup()).toBe(row.needsServerSetup);
  expect(guessDeviceKind(navigator.userAgent)).toBe(row.deviceKindGuess);

  // 起動時の経路（boot.ts）。ログで経路名を取る
  const logs: string[] = [];
  const base = { ...currentBootEnv(), log: (m: string) => logs.push(m) };
  expect(bootReadApi(base).kind).toBe(row.readApi);
  expect(bootWriteApi(base).kind).toBe(row.writeApi);
  const chat = bootChatTransport({ ...currentChatBootEnv(), log: (m) => logs.push(m) });
  expect(chat !== null ? 'rust' : 'none').toBe(row.chat);
}

describe('デバイス判定の特徴付け（現在の挙動を固定）', () => {
  it.each(EXPECTED.map((row) => [row.os, row] as const))('UA のみ（Rust の値なし）: %s', (os, row) => {
    stubTauri({ os });
    assertRow(row);
  });

  it.each(EXPECTED.map((row) => [row.os, row] as const))('Rust の値あり（同じ表になる）: %s', (os, row) => {
    stubTauri({ os, inject: injectedPlatform(os) });
    assertRow(row);
  });

  it.each([
    ['null', null],
    ['文字列', 'linux'],
    ['空のオブジェクト', {}],
    ['os だけ', { os: 'linux' }],
    ['型が違う', { os: 1, desktop: true, android: false }],
  ] as const)('Rust の値が壊れている（%s）ときは UA に戻る', (_label, bad) => {
    for (const row of EXPECTED) {
      stubTauri({ os: row.os, inject: bad });
      assertRow(row);
    }
  });

  it('Rust の値は UA より優先する（矛盾するとき）', () => {
    // UA は Linux だが、Rust は Windows と言っている → shared storage は Windows として扱う
    stubTauri({ os: 'linux', inject: { os: 'windows', desktop: true, android: false } });
    expect(isLinuxDesktop()).toBe(false);
    expect(isDesktopStorageSupported()).toBe(true);
  });

  it('書込の本体の形（base64 か raw）は Android の Tauri だけ base64', () => {
    for (const row of EXPECTED) {
      stubTauri({ os: row.os });
      const base = currentBootEnv();
      const choice = bootWriteApi({ ...base, log: undefined });
      if (row.writeMode === 'none') expect(choice.kind).toBe('http');
      else expect(choice.kind === 'tauri' && (row.writeMode === 'base64') === (base.bodyMode === 'base64')).toBe(true);
    }
  });

  it('Tauri の外（想定外の環境）は、読取・書込は HTTP、チャットは無い（案内の前の挙動）', () => {
    stubTauri({ os: 'linux' });
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(isTauri()).toBe(false);
    expect(bootReadApi({ ...currentBootEnv(), log: undefined }).kind).toBe('http');
    expect(bootWriteApi({ ...currentBootEnv(), log: undefined }).kind).toBe('http');
    expect(bootChatTransport(currentChatBootEnv())).toBeNull();
  });
});

describe('フラグ（localStorage）による上書き', () => {
  it('disnans.rustApi が "0" なら読取・書込は http（Windows・Linux・Android とも）', () => {
    for (const os of ['windows', 'linux', 'android'] as const) {
      stubTauri({ os, storage: { 'disnans.rustApi': '0' } });
      const env = currentBootEnv();
      expect(bootReadApi({ ...env, log: undefined }).kind).toBe('http');
      expect(bootWriteApi({ ...env, log: undefined }).kind).toBe('http');
    }
  });

  it('chat: Tauri の Windows・Linux と Android は flag によらず rust（S7。flag は見ない）', () => {
    for (const [os, flag] of [
      ['windows', '0'],
      ['windows', null],
      ['android', '1'],
      ['android', null],
      ['android', '0'],
    ] as const) {
      stubTauri({ os, storage: flag === null ? {} : { 'disnans.rustChat': flag } });
      expect(bootChatTransport(currentChatBootEnv())).not.toBeNull();
    }
  });
});

describe('通知とアップデートの経路（モジュールの読込時に決まる値）', () => {
  it.each([
    ['windows', 'desktop'],
    ['linux', 'desktop'],
    ['other', 'desktop'],
    ['android', 'android'],
  ] as const)('通知の backend（%s → %s）', async (os, backend) => {
    stubTauri({ os });
    vi.resetModules();
    const { notifications } = await import('./stores/notifications.svelte');
    expect(notifications.backend).toBe(backend);
  });

  it.each([
    ['windows', true],
    ['android', true],
  ] as const)('アップデートの経路がある（%s → %s）', async (os, supported) => {
    stubTauri({ os });
    vi.resetModules();
    const { updater } = await import('./stores/updater.svelte');
    expect(updater.supported).toBe(supported);
  });
});
