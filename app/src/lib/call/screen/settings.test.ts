// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SCREEN_SETTINGS_DEFAULT, ScreenShareSettings, screenShareSourceOf, simpleSettingsSource } from './settings.svelte';
import { DeviceSettings, type DeviceDeps } from '../../stores/deviceSettings.svelte';
import { LEGACY, legacyScreenShare } from '../../settingsModel';
import type { DeviceApi, DeviceView } from '../../transport/device';
import type { ScreenSettingsValue } from './types';

const LEGACY_VALUE: ScreenSettingsValue = { fps: 20, quality: 'p1080', color: 'gray' };
const SAVED: ScreenSettingsValue = { fps: 5, quality: 'p480', color: 'c256' };

describe('ScreenShareSettings（値の決まり方）', () => {
  it('未設定で旧い値も無ければ、既定（5 fps・720p・フルカラー）。読むだけで保存しない', () => {
    const src = simpleSettingsSource({ synced: false });
    const s = new ScreenShareSettings(src, null);
    expect(s.value).toEqual({ fps: 5, quality: 'p720', color: 'full' });
    expect(src.writes).toEqual([]);
  });

  it('保存があれば、それを返す（旧い値より優先）', () => {
    const s = new ScreenShareSettings(simpleSettingsSource({ stored: SAVED, synced: true }), LEGACY_VALUE);
    expect(s.value).toEqual(SAVED);
  });

  it('サーバーを読む前でも、旧い値が見える（起動直後）', () => {
    const src = simpleSettingsSource({ synced: false });
    const s = new ScreenShareSettings(src, LEGACY_VALUE);
    expect(s.value).toEqual(LEGACY_VALUE);
    expect(src.writes).toEqual([]);
  });

  it('既定の値は、読み手が書き換えても次の読みに影響しない（共有の定数を汚さない）', () => {
    const s = new ScreenShareSettings(simpleSettingsSource(), null);
    expect(Object.isFrozen(SCREEN_SETTINGS_DEFAULT)).toBe(true);
    expect(s.value).toEqual({ fps: 5, quality: 'p720', color: 'full' });
  });
});

describe('ScreenShareSettings（移行）', () => {
  it('サーバーを読んだあと、保存が未設定で旧い値があれば、一度だけ保存先へ書く（旧い値は残す）', () => {
    const src = simpleSettingsSource({ synced: false });
    const s = new ScreenShareSettings(src, LEGACY_VALUE);
    expect(src.writes).toEqual([]);
    src.setSynced(true);
    expect(src.writes).toEqual([LEGACY_VALUE]);
    expect(s.value).toEqual(LEGACY_VALUE);
    // もう一度読み直しても、書かない
    src.setSynced(false);
    src.setSynced(true);
    expect(src.writes).toHaveLength(1);
  });

  it('既にサーバーに保存があれば、旧い値で上書きしない', () => {
    const src = simpleSettingsSource({ stored: SAVED, synced: false });
    new ScreenShareSettings(src, LEGACY_VALUE);
    src.setSynced(true);
    expect(src.writes).toEqual([]);
    expect(src.stored).toEqual(SAVED);
  });

  it('旧い値が無ければ、読めても何も書かない（未設定のまま）', () => {
    const src = simpleSettingsSource({ synced: true });
    new ScreenShareSettings(src, null);
    expect(src.writes).toEqual([]);
    expect(src.stored).toBeNull();
  });

  it('利用者が先に変えていたら、旧い値は使わず、その変更を残す（読み終わって上書きしない）', () => {
    const src = simpleSettingsSource({ synced: false });
    const s = new ScreenShareSettings(src, LEGACY_VALUE);
    s.patch({ fps: 20 });
    expect(src.stored).toEqual({ fps: 20, quality: 'p1080', color: 'gray' });
    src.setSynced(true);
    expect(src.writes).toEqual([{ fps: 20, quality: 'p1080', color: 'gray' }]);
  });
});

describe('ScreenShareSettings（変更）', () => {
  it('一部だけ変えると、今の値（旧い値を含む）に足して保存する', () => {
    const src = simpleSettingsSource({ synced: true });
    const s = new ScreenShareSettings(src, LEGACY_VALUE);
    s.patch({ color: 'full' });
    expect(src.writes.at(-1)).toEqual({ fps: 20, quality: 'p1080', color: 'full' });
  });

  it('変わったことを購読者へ知らせる（解除したあとは届かない）', () => {
    const src = simpleSettingsSource({ stored: SAVED, synced: true });
    const s = new ScreenShareSettings(src, null);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.patch({ fps: 20 });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.patch({ fps: 5 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---- デバイスの設定（DeviceSettings）と一緒に動く ----

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string | null) => (v === null ? m.delete(k) : m.set(k, v)),
  };
}

/** サーバーの中身を持つ偽の API（deviceSettings.test.ts と同じ形） */
function fakeServer(prefs: Record<string, unknown> | null) {
  let server: Record<string, unknown> | null = prefs === null ? null : { ...prefs };
  const api = {
    id: vi.fn(async () => 'dev-1'),
    register: vi.fn(async () => {}),
    read: vi.fn(async (): Promise<DeviceView> => ({ prefs: server ?? {}, updatedAt: server ? 1 : null, saved: server !== null })),
    write: vi.fn(async (_id: string, body: Record<string, unknown>): Promise<DeviceView> => {
      server = { ...body };
      return { prefs: server, updatedAt: 2, saved: true };
    }),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => {}),
  };
  return { api: api as unknown as DeviceApi & typeof api, peek: () => server };
}

function devices(api: DeviceApi, local: ReturnType<typeof memory>) {
  const d: DeviceDeps = { api, get: local.get, set: local.set, defaultName: () => 'Linux' };
  return new DeviceSettings(d);
}

describe('画面共有の設定と、デバイスの設定（移行の実物の流れ）', () => {
  it('サーバーにデバイス設定がまだ無い場合も、同期通知で移行した値を古い null の書き込みで消さない', async () => {
    const local = memory({ [LEGACY.screenShare]: JSON.stringify({ fps: 20, quality: 'high', color: 'gray' }) });
    const srv = fakeServer(null);
    const ds = devices(srv.api, local);
    const s = new ScreenShareSettings(screenShareSourceOf(ds), legacyScreenShare(local.get));
    await ds.start();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(srv.peek()).toMatchObject({ screenShare: { fps: 20, quality: 'p1080', color: 'gray' } });
    expect(s.value).toEqual({ fps: 20, quality: 'p1080', color: 'gray' });
    expect(srv.api.write).toHaveBeenCalledTimes(1);
  });

  it('サーバーに設定（ほかの項目だけ）があり、画面共有が未設定でも、旧い値を一度移し、旧い保存は残す', async () => {
    const local = memory({ [LEGACY.screenShare]: JSON.stringify({ fps: 20, quality: 'high', color: 'full' }) });
    const srv = fakeServer({ inputId: 'mic-1', orientation: 'portrait', pluginsDisabled: [], pluginsDevDir: null, hideNavigationBar: false, output: null, deviceKind: null, screenShare: null });
    const ds = devices(srv.api, local);
    const s = new ScreenShareSettings(screenShareSourceOf(ds), legacyScreenShare(local.get));
    await ds.start();
    expect(ds.synced).toBe(true);
    await vi.waitFor(() => expect(srv.peek()).toMatchObject({ screenShare: { fps: 20, quality: 'p1080', color: 'full' }, inputId: 'mic-1' }));
    expect(s.value).toEqual({ fps: 20, quality: 'p1080', color: 'full' });
    expect(local.m.get(LEGACY.screenShare)).toBe(JSON.stringify({ fps: 20, quality: 'high', color: 'full' }));
  });

  it('サーバーの画面共有の値があれば、旧い値で上書きしない', async () => {
    const local = memory({ [LEGACY.screenShare]: JSON.stringify({ fps: 20, quality: 'p1080', color: 'gray' }) });
    const srv = fakeServer({ screenShare: { fps: 5, quality: 'p480', color: 'c256' } });
    const ds = devices(srv.api, local);
    await ds.start();
    expect(srv.peek()).toMatchObject({ screenShare: { fps: 5, quality: 'p480', color: 'c256' } });
    expect(srv.api.write).not.toHaveBeenCalled();
  });
});
