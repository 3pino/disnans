// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { VIBRATE_COMMAND, vibrate } from './haptics';
import { deviceSettings } from './stores/deviceSettings.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type Win = Window & { __TAURI_INTERNALS__?: unknown; __DISNANS_PLATFORM__?: unknown };
const win = window as Win;
const initialSettings = deviceSettings.raw;

function setNavigatorVibrate(fn: ((ms: number) => boolean) | undefined) {
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: fn });
}

/** Tauri の Android（Rust が入れた値で判定する） */
function tauriAndroid() {
  win.__TAURI_INTERNALS__ = {};
  win.__DISNANS_PLATFORM__ = { os: 'android', desktop: false, android: true, capabilities: null };
}

beforeEach(() => {
  deviceSettings.raw = { ...initialSettings, hapticsEnabled: true };
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  deviceSettings.raw = initialSettings;
  delete win.__TAURI_INTERNALS__;
  delete win.__DISNANS_PLATFORM__;
  setNavigatorVibrate(undefined);
});

describe('vibrate（操作の合図の振動）', () => {
  it('Android の設定がオフなら、ネイティブも WebView の振動も呼ばない', async () => {
    tauriAndroid();
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: false };
    const nav = vi.fn(() => true);
    setNavigatorVibrate(nav);
    vibrate(12);
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it('ネイティブの読み込みを待つ間にオフになっても、遅れて振動しない', async () => {
    tauriAndroid();
    vibrate(12);
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: false };
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('オフからオンへ変えると、次の操作から振動する', async () => {
    tauriAndroid();
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: false };
    vibrate(12);
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: true };
    vibrate(12);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });

  it('Android 以外の既存経路には Android の設定を適用しない', () => {
    win.__DISNANS_PLATFORM__ = { os: 'linux', desktop: true, android: false, capabilities: null };
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: false };
    const nav = vi.fn(() => true);
    setNavigatorVibrate(nav);
    vibrate(12);
    expect(nav).toHaveBeenCalledWith(12);
  });

  it('Tauri の Android では、ネイティブの振動コマンドを { ms } で呼び、WebView の振動は使わない', async () => {
    tauriAndroid();
    vi.mocked(invoke).mockResolvedValue(undefined);
    const nav = vi.fn(() => true);
    setNavigatorVibrate(nav);
    vibrate(12);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith(VIBRATE_COMMAND, { ms: 12 });
    expect(VIBRATE_COMMAND).toBe('plugin:notifier|vibrate');
    expect(nav).not.toHaveBeenCalled();
  });

  it('ネイティブの振動が失敗しても、例外を外へ出さない（振動しないだけ）', async () => {
    tauriAndroid();
    vi.mocked(invoke).mockRejectedValue(new Error('command not found'));
    setNavigatorVibrate(vi.fn(() => true));
    expect(() => vibrate(12)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('Tauri でも Android でなければ（デスクトップ）、navigator.vibrate を使う', () => {
    win.__TAURI_INTERNALS__ = {};
    win.__DISNANS_PLATFORM__ = { os: 'linux', desktop: true, android: false, capabilities: null };
    const nav = vi.fn((_ms: number) => true);
    setNavigatorVibrate(nav);
    vibrate(12);
    expect(nav).toHaveBeenCalledWith(12);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ブラウザーでは navigator.vibrate を使う', () => {
    const nav = vi.fn((_ms: number) => true);
    setNavigatorVibrate(nav);
    vibrate(10);
    expect(nav).toHaveBeenCalledWith(10);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('navigator.vibrate が無い・例外を投げるときも、何もせず例外を出さない', () => {
    setNavigatorVibrate(undefined);
    expect(() => vibrate(12)).not.toThrow();
    setNavigatorVibrate(() => {
      throw new Error('denied');
    });
    expect(() => vibrate(12)).not.toThrow();
  });
});
