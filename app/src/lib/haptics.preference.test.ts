// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SET_HAPTICS_COMMAND, startHapticsPreferences } from './haptics';
import { deviceSettings, DEVICE_CACHE_KEY } from './stores/deviceSettings.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));
const win = window as Window & { __TAURI_INTERNALS__?: unknown; __DISNANS_PLATFORM__?: unknown };
const initial = deviceSettings.raw;
const oldCache = localStorage.getItem(DEVICE_CACHE_KEY);
let stop = () => {};
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  win.__TAURI_INTERNALS__ = {};
  win.__DISNANS_PLATFORM__ = { os: 'android', android: true, desktop: false, capabilities: null };
  deviceSettings.raw = { ...initial, hapticsEnabled: true };
});
afterEach(() => {
  stop();
  stop = () => {};
  deviceSettings.raw = initial;
  if (oldCache === null) localStorage.removeItem(DEVICE_CACHE_KEY);
  else localStorage.setItem(DEVICE_CACHE_KEY, oldCache);
  delete win.__TAURI_INTERNALS__;
  delete win.__DISNANS_PLATFORM__;
  vi.restoreAllMocks();
});
const turn = () => new Promise((r) => setTimeout(r, 0));

describe('操作時の振動の設定と WebView の同期', () => {
  it('起動時のオフと、その後のオンをネイティブへ渡す（通知の設定は送らない）', async () => {
    deviceSettings.raw = { ...deviceSettings.raw, hapticsEnabled: false };
    stop = startHapticsPreferences();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(SET_HAPTICS_COMMAND, { enabled: false }));
    deviceSettings.set('hapticsEnabled', true);
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith(SET_HAPTICS_COMMAND, { enabled: true }));
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === SET_HAPTICS_COMMAND)).toBe(true);
  });

  it('ネイティブへの変更が進行中なら順番を保ち、最後のオフを上書きしない', async () => {
    let finish = (_value: unknown) => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    stop = startHapticsPreferences();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    deviceSettings.set('hapticsEnabled', false);
    deviceSettings.set('hapticsEnabled', true);
    deviceSettings.set('hapticsEnabled', false);
    await turn();
    expect(invoke).toHaveBeenCalledOnce();
    finish(undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith(SET_HAPTICS_COMMAND, { enabled: false });
  });

  it('破棄すると、未送信の変更と購読・前面復帰の同期を解除する', async () => {
    stop = startHapticsPreferences();
    stop();
    deviceSettings.set('hapticsEnabled', false);
    window.dispatchEvent(new Event('focus'));
    await turn();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('失敗しても前面復帰で現在の値を再同期する', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce(new Error('fake failure'));
    stop = startHapticsPreferences();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[haptics] preference_sync_failed'));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith(SET_HAPTICS_COMMAND, { enabled: true });
  });

  it('Android の Tauri 以外では同期の購読もネイティブ呼び出しもしない', async () => {
    win.__DISNANS_PLATFORM__ = { os: 'linux', android: false, desktop: true, capabilities: null };
    stop = startHapticsPreferences();
    deviceSettings.set('hapticsEnabled', false);
    await turn();
    expect(invoke).not.toHaveBeenCalled();
  });
});
