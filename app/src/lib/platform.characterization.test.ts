// ステップ7 P0: 端末分岐の特徴付けテスト。
// いまの判定（UA・Tauri の有無）の結果を、環境の組み合わせごとに固定する。
// この表が P1・P2 の前後で変わらないことが、挙動を変えていないことの確認になる（変えるなら表を直す前に理由を書く）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAndroid, isLinuxDesktop, isTauri, needsServerSetup } from './config';
import { isDesktopStorageSupported } from './desktopStorage';
import { devFolderSupported } from './plugins/dev';
import { isMac } from './plugins/hotkey';
import { guessDeviceKind } from './deviceKind.svelte';
import { bootChatTransport, bootReadApi, bootWriteApi, currentBootEnv } from './transport/boot';
import type { ReadApiEnv } from './transport/select';

type Env = { name: string; tauri: boolean; userAgent: string; platform: string };

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) WebKitGTK/2.44',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
};

const ENVS: Env[] = [
  { name: 'windows Tauri', tauri: true, userAgent: UA.windows, platform: 'Win32' },
  { name: 'linux Tauri', tauri: true, userAgent: UA.linux, platform: 'Linux x86_64' },
  { name: 'mac Tauri', tauri: true, userAgent: UA.mac, platform: 'MacIntel' },
  { name: 'android Tauri', tauri: true, userAgent: UA.android, platform: 'Linux armv8l' },
  { name: 'windows browser', tauri: false, userAgent: UA.windows, platform: 'Win32' },
  { name: 'linux browser', tauri: false, userAgent: UA.linux, platform: 'Linux x86_64' },
  { name: 'mac browser', tauri: false, userAgent: UA.mac, platform: 'MacIntel' },
  { name: 'android browser', tauri: false, userAgent: UA.android, platform: 'Linux armv8l' },
];

/** 環境を差し替える（server と localStorage は空。sessionStorage も無い）。inject は Rust が入れる値（__DISNANS_PLATFORM__） */
function stubEnv(env: Env, inject?: unknown): void {
  vi.stubGlobal('navigator', { userAgent: env.userAgent, platform: env.platform });
  const window: Record<string, unknown> = {
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  if (env.tauri) window.__TAURI_INTERNALS__ = {};
  if (inject !== undefined) window.__DISNANS_PLATFORM__ = inject;
  vi.stubGlobal('window', window);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** 期待値の表: 環境ごとの 1 行。列は下の見出しの順 */
type Row = {
  env: string;
  isTauri: boolean;
  isAndroid: boolean;
  isLinuxDesktop: boolean;
  sharedStorage: boolean; // isDesktopStorageSupported（macOS は false のまま）
  devFolder: boolean;
  isMac: boolean;
  needsServerSetup: boolean;
  readApi: 'tauri' | 'http';
  writeApi: 'tauri' | 'http';
  writeMode: 'raw' | 'base64' | 'none';
  chat: 'rust' | 'js';
  deviceKindGuess: 'smartphone' | 'laptop';
};

// 現在の挙動（P0 時点）。mac は Tauri でも shared storage と Rust の API（読取・書込）は使わない（Q1 の判断: 変えない）
const EXPECTED: Row[] = [
  { env: 'windows Tauri', isTauri: true, isAndroid: false, isLinuxDesktop: false, sharedStorage: true, devFolder: true, isMac: false, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'raw', chat: 'rust', deviceKindGuess: 'laptop' },
  { env: 'linux Tauri', isTauri: true, isAndroid: false, isLinuxDesktop: true, sharedStorage: true, devFolder: true, isMac: false, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'raw', chat: 'rust', deviceKindGuess: 'laptop' },
  { env: 'mac Tauri', isTauri: true, isAndroid: false, isLinuxDesktop: false, sharedStorage: false, devFolder: true, isMac: true, needsServerSetup: true, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'js', deviceKindGuess: 'laptop' },
  { env: 'android Tauri', isTauri: true, isAndroid: true, isLinuxDesktop: false, sharedStorage: false, devFolder: false, isMac: false, needsServerSetup: true, readApi: 'tauri', writeApi: 'tauri', writeMode: 'base64', chat: 'js', deviceKindGuess: 'smartphone' },
  { env: 'windows browser', isTauri: false, isAndroid: false, isLinuxDesktop: false, sharedStorage: false, devFolder: false, isMac: false, needsServerSetup: false, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'js', deviceKindGuess: 'laptop' },
  { env: 'linux browser', isTauri: false, isAndroid: false, isLinuxDesktop: false, sharedStorage: false, devFolder: false, isMac: false, needsServerSetup: false, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'js', deviceKindGuess: 'laptop' },
  { env: 'mac browser', isTauri: false, isAndroid: false, isLinuxDesktop: false, sharedStorage: false, devFolder: false, isMac: true, needsServerSetup: false, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'js', deviceKindGuess: 'laptop' },
  { env: 'android browser', isTauri: false, isAndroid: true, isLinuxDesktop: false, sharedStorage: false, devFolder: false, isMac: false, needsServerSetup: false, readApi: 'http', writeApi: 'http', writeMode: 'none', chat: 'js', deviceKindGuess: 'smartphone' },
];

/** Rust の値（platform.rs と同じ形）。Tauri の行だけ作る */
function injectedFor(env: Env): unknown {
  const os = env.name.startsWith('windows') ? 'windows' : env.name.startsWith('linux') ? 'linux' : env.name.startsWith('mac') ? 'macos' : 'android';
  return { os, desktop: os !== 'android', android: os === 'android' };
}

function assertRow(env: Env, row: Row): void {

    expect(isTauri()).toBe(row.isTauri);
    expect(isAndroid()).toBe(row.isAndroid);
    expect(isLinuxDesktop()).toBe(row.isLinuxDesktop);
    expect(isDesktopStorageSupported()).toBe(row.sharedStorage);
    expect(devFolderSupported()).toBe(row.devFolder);
    expect(isMac()).toBe(row.isMac);
    expect(needsServerSetup()).toBe(row.needsServerSetup);
    expect(guessDeviceKind(env.userAgent)).toBe(row.deviceKindGuess);

    // 起動時の経路（boot.ts）。ログで経路名を取る
    const logs: string[] = [];
    const base: ReadApiEnv = { ...currentBootEnv(), log: (m) => logs.push(m) };
    expect(bootReadApi(base).kind).toBe(row.readApi);
    expect(bootWriteApi(base).kind).toBe(row.writeApi);
    const chatT = bootChatTransport({
      flag: null,
      desktop: base.desktop,
      android: base.android,
      invoke: base.invoke,
      context: base.context,
      log: (m) => logs.push(m),
    });
    expect(chatT !== null ? 'rust' : 'js').toBe(row.chat);
}

describe('端末判定の特徴付け（現在の挙動を固定）', () => {
  it.each(EXPECTED.map((row) => [row.env, row] as const))('UA のみ（Rust の値なし）: %s', (name, row) => {
    const env = ENVS.find((e) => e.name === name);
    if (!env) throw new Error(`環境が無い: ${name}`);
    stubEnv(env);
    assertRow(env, row);
  });

  it.each(EXPECTED.filter((r) => r.isTauri).map((row) => [row.env, row] as const))('Rust の値あり（同じ表になる）: %s', (name, row) => {
    const env = ENVS.find((e) => e.name === name)!;
    stubEnv(env, injectedFor(env));
    assertRow(env, row);
  });

  it.each([
    ['null', null],
    ['文字列', 'linux'],
    ['空のオブジェクト', {}],
    ['os だけ', { os: 'linux' }],
    ['型が違う', { os: 1, desktop: true, android: false }],
  ] as const)('Rust の値が壊れている（%s）ときは UA に戻る', (_label, bad) => {
    for (const row of EXPECTED.filter((r) => r.isTauri)) {
      const env = ENVS.find((e) => e.name === row.env)!;
      stubEnv(env, bad);
      assertRow(env, row);
    }
  });

  it('Rust の値は UA より優先する（矛盾するとき）', () => {
    // UA は Linux だが、Rust は Windows と言っている → shared storage は Windows として扱う
    stubEnv({ name: 'x', tauri: true, userAgent: UA.linux, platform: 'Linux x86_64' }, { os: 'windows', desktop: true, android: false });
    expect(isLinuxDesktop()).toBe(false);
    expect(isDesktopStorageSupported()).toBe(true);
    expect(isMac()).toBe(false);
  });

  it('書込の本体の形（base64 か raw）は Android の Tauri だけ base64', () => {
    for (const row of EXPECTED) {
      const env = ENVS.find((e) => e.name === row.env)!;
      stubEnv(env);
      const base = currentBootEnv();
      const choice = bootWriteApi({ ...base, log: undefined });
      if (row.writeMode === 'none') expect(choice.kind).toBe('http');
      else expect(choice.kind === 'tauri' && (row.writeMode === 'base64') === !!base.android).toBe(true);
    }
  });
});

describe('フラグ（localStorage）による上書き', () => {
  it('disnans.rustApi が "0" なら読取・書込は http（desktop・android とも）', () => {
    for (const name of ['windows Tauri', 'linux Tauri', 'android Tauri']) {
      stubEnv(ENVS.find((e) => e.name === name)!);
      const env = { ...currentBootEnv(), flag: '0' };
      expect(bootReadApi({ ...env, log: undefined }).kind).toBe('http');
      expect(bootWriteApi({ ...env, log: undefined }).kind).toBe('http');
    }
  });

  it('chat: desktop は "0" で js、Android は "1" で rust（opt-in）', () => {
    const chat = (name: string, flag: string | null) => {
      stubEnv(ENVS.find((e) => e.name === name)!);
      const base = currentBootEnv();
      return bootChatTransport({ flag, desktop: base.desktop, android: base.android, invoke: base.invoke, context: base.context, log: undefined }) !== null ? 'rust' : 'js';
    };
    expect(chat('windows Tauri', '0')).toBe('js');
    expect(chat('windows Tauri', null)).toBe('rust');
    expect(chat('android Tauri', '1')).toBe('rust');
    expect(chat('android Tauri', null)).toBe('js');
    expect(chat('android Tauri', '0')).toBe('js');
  });
});

describe('通知とアップデートの経路（モジュールの読込時に決まる値）', () => {
  it.each([
    ['windows Tauri', 'desktop'],
    ['linux Tauri', 'desktop'],
    ['mac Tauri', 'desktop'],
    ['android Tauri', 'android'],
    ['windows browser', 'web'],
    ['android browser', 'web'],
  ] as const)('通知の backend（%s → %s）', async (name, backend) => {
    stubEnv(ENVS.find((e) => e.name === name)!);
    vi.resetModules();
    const { notifications } = await import('./stores/notifications.svelte');
    expect(notifications.backend).toBe(backend);
  });

  it.each([
    ['windows Tauri', true],
    ['android Tauri', true],
    ['windows browser', false],
  ] as const)('アップデートの対象（%s → %s）', async (name, supported) => {
    stubEnv(ENVS.find((e) => e.name === name)!);
    vi.resetModules();
    const { updater } = await import('./stores/updater.svelte');
    expect(updater.supported).toBe(supported);
  });
});
