// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import SettingsField from './SettingsField.svelte';
import { guiSections, settingsPage, SETTINGS_TOP } from '../lib/uiTree';
import { deviceSettings, DEVICE_CACHE_KEY } from '../lib/stores/deviceSettings.svelte';
import { vibrate, VIBRATE_COMMAND } from '../lib/haptics';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
const initialSettings = deviceSettings.raw;
const oldCache = localStorage.getItem(DEVICE_CACHE_KEY);
const win = window as Window & { __TAURI_INTERNALS__?: unknown; __DISNANS_PLATFORM__?: unknown };

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target?.remove();
  deviceSettings.raw = initialSettings;
  if (oldCache === null) localStorage.removeItem(DEVICE_CACHE_KEY);
  else localStorage.setItem(DEVICE_CACHE_KEY, oldCache);
  delete win.__TAURI_INTERNALS__;
  delete win.__DISNANS_PLATFORM__;
  vi.mocked(invoke).mockClear();
});

describe('Android の操作時の振動（共通の設定 Field）', () => {
  it('実際の設定のスイッチからオフ/オンでき、次の操作の振動に反映される', async () => {
    win.__TAURI_INTERNALS__ = {};
    win.__DISNANS_PLATFORM__ = { os: 'android', android: true, desktop: false, capabilities: null };
    deviceSettings.raw = { ...initialSettings, hapticsEnabled: true };
    const field = guiSections(settingsPage(SETTINGS_TOP)!, { tauri: true, android: true, devUser: false })
      .flatMap((s) => s.items).find((item) => item.type === 'field' && item.key === 'hapticsEnabled');
    expect(field?.type).toBe('field');
    if (!field || field.type !== 'field') throw new Error('haptics field missing');
    target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(SettingsField, { target, props: { field } });
    flushSync();
    const toggle = target.querySelector<HTMLButtonElement>('[role="switch"][aria-label="操作時の振動"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click();
    flushSync();
    expect(deviceSettings.hapticsEnabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    vibrate(12);
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
    toggle.click();
    flushSync();
    expect(deviceSettings.hapticsEnabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    vibrate(12);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith(VIBRATE_COMMAND, { ms: 12 });
  });
});
