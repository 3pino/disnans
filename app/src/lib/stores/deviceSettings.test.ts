// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_CACHE_KEY, DEVICE_NAME_KEY, DeviceSettings, defaultDeviceName, type DeviceDeps } from './deviceSettings.svelte';
import { setSettingsErrorHandler } from '../settingsModel';
import type { DeviceApi, DeviceView } from '../transport/device';

/** 手元の localStorage の代わり */
function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string | null) => (v === null ? m.delete(k) : m.set(k, v)),
  };
}

/** Rust の api_device_* の代わり（サーバーの中身を持つ） */
function fakeApi(opts: { saved?: boolean; prefs?: Record<string, unknown>; failWrite?: boolean } = {}) {
  let server: Record<string, unknown> | null = opts.saved === false ? null : { ...(opts.prefs ?? {}) };
  const api = {
    id: vi.fn(async () => 'dev-1'),
    register: vi.fn(async (_id: string, _name: string) => {}),
    read: vi.fn(async (_id: string): Promise<DeviceView> => ({ prefs: server ?? {}, updatedAt: server ? 1 : null, saved: server !== null })),
    write: vi.fn(async (_id: string, body: Record<string, unknown>): Promise<DeviceView> => {
      if (opts.failWrite) throw new Error('書けません');
      server = { ...body, hideNavigationBar: body.hideNavigationBar === true };
      return { prefs: server, updatedAt: 2, saved: true };
    }),
  };
  return { api, peek: () => server };
}

function deps(over: Partial<DeviceDeps> & { api?: DeviceApi | null; local?: ReturnType<typeof memory> } = {}) {
  const local = over.local ?? memory();
  const d: DeviceDeps = {
    api: over.api === undefined ? null : over.api,
    get: local.get,
    set: local.set,
    defaultName: () => 'Linux',
    now: over.now,
  };
  return { d, local };
}

describe('defaultDeviceName', () => {
  it('OS の名前（ホスト名は取れないので付けない）', () => {
    expect(defaultDeviceName('windows')).toBe('Windows');
    expect(defaultDeviceName('linux')).toBe('Linux');
    expect(defaultDeviceName('android')).toBe('Android');
    expect(defaultDeviceName('')).toBe('このデバイス');
  });
});

describe('DeviceSettings（ブラウザ版: localStorage だけ）', () => {
  it('以前の localStorage の値を、キャッシュが無いときに一度取り込む', () => {
    const local = memory({ 'disnans.hideNavigationBar': '1', 'disnans.deviceKind': 'tablet' });
    const { d } = deps({ local });
    const s = new DeviceSettings(d);
    expect(s.hideNavigationBar).toBe(true);
    expect(s.deviceKind).toBe('tablet');
  });

  it('値を変えるとキャッシュに残り、次の起動で読める', () => {
    const local = memory();
    const s = new DeviceSettings(deps({ local }).d);
    s.set('orientation', 'portrait');
    expect(s.orientation).toBe('portrait');
    expect(JSON.parse(local.m.get(DEVICE_CACHE_KEY) ?? '{}')).toMatchObject({ orientation: 'portrait' });
    expect(new DeviceSettings(deps({ local }).d).orientation).toBe('portrait');
  });

  it('start はデバイスを使わずに ready になる', async () => {
    const s = new DeviceSettings(deps().d);
    await s.start();
    expect(s.ready).toBe(true);
  });

  it('変わったときに購読者へ知らせる（解除したあとは届かない）', () => {
    const s = new DeviceSettings(deps().d);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.set('pluginsDisabled', ['dice']);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.pluginsDisabled).toEqual(['dice']);
    off();
    s.set('pluginsDisabled', []);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('デバイスの名前は保存したものが優先、無ければ既定', async () => {
    const local = memory();
    const s = new DeviceSettings(deps({ local }).d);
    expect(s.deviceName()).toBe('Linux');
    await s.renameDevice('  自宅のPC  ');
    expect(s.deviceName()).toBe('自宅のPC');
    expect(local.m.get(DEVICE_NAME_KEY)).toBe('自宅のPC');
    await s.renameDevice('  ');
    expect(s.deviceName()).toBe('Linux');
  });
});

describe('DeviceSettings（Tauri: サーバーのデバイスの設定）', () => {
  it('登録して読む。サーバーに設定があれば、それを使う', async () => {
    const { api } = fakeApi({ prefs: { deviceKind: 'monitor', orientation: 'media' } });
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    expect(api.id).toHaveBeenCalled();
    expect(api.register).toHaveBeenCalledWith('dev-1', 'Linux');
    expect(s.deviceKind).toBe('monitor');
    expect(s.orientation).toBe('media');
    expect(s.ready).toBe(true);
  });

  it('設定が無ければ（saved: false）、いまの値（以前の localStorage の値を含む）を一度送って作る', async () => {
    const local = memory({ 'disnans.hideNavigationBar': '1' });
    const { api, peek } = fakeApi({ saved: false });
    const s = new DeviceSettings(deps({ api, local }).d);
    await s.start();
    expect(api.write).toHaveBeenCalledWith('dev-1', expect.objectContaining({ hideNavigationBar: true }));
    expect(peek()).toMatchObject({ hideNavigationBar: true });
    expect(s.hideNavigationBar).toBe(true);
  });

  it('変えた値は順番に送り、サーバーの返事に合わせる', async () => {
    const { api, peek } = fakeApi({ prefs: {} });
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    s.set('pluginsDevDir', '/a');
    s.set('pluginsDisabled', ['dice']);
    await vi.waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(peek()).toMatchObject({ pluginsDisabled: ['dice'], pluginsDevDir: '/a' }));
    expect(s.pluginsDevDir).toBe('/a');
  });

  it('送れなかったら、利用者に知らせ、手元の値は残す', async () => {
    const reported: string[] = [];
    setSettingsErrorHandler((t) => reported.push(t));
    const { api } = fakeApi({ prefs: {}, failWrite: true });
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    s.set('deviceKind', 'tablet');
    await vi.waitFor(() => expect(reported.length).toBe(1));
    expect(reported[0]).toContain('デバイスの設定を保存できませんでした');
    expect(s.deviceKind).toBe('tablet');
    setSettingsErrorHandler((t) => console.error(t));
  });

  it('読めなかったら、利用者に知らせ、ready にはなる（キャッシュの値で動く）', async () => {
    const reported: string[] = [];
    setSettingsErrorHandler((t) => reported.push(t));
    const api = fakeApi().api;
    api.id.mockRejectedValueOnce(new Error('壊れた'));
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    expect(s.ready).toBe(true);
    expect(reported[0]).toContain('デバイスの設定を読めませんでした');
    setSettingsErrorHandler((t) => console.error(t));
  });

  it('書き込みの途中の refresh は、サーバーの古い値で上書きしない', async () => {
    const { api } = fakeApi({ prefs: {} });
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    s.set('deviceKind', 'laptop');
    await s.refresh();
    expect(s.deviceKind).toBe('laptop');
    await vi.waitFor(() => expect(api.write).toHaveBeenCalled());
  });

  it('読み直しは最短 5 秒の間隔（連続で呼んでも読むのは1回）。間隔が過ぎたら読む', async () => {
    let t = 10_000;
    const { api } = fakeApi({ prefs: { deviceKind: 'tablet' } });
    const s = new DeviceSettings(deps({ api, now: () => t }).d);
    await s.start();
    expect(api.read).toHaveBeenCalledTimes(1); // 起動の読み込み（間引きの対象外）
    await s.refresh();
    await s.refresh({ quiet: true });
    expect(api.read).toHaveBeenCalledTimes(2);
    t += 4_999;
    await s.refresh();
    expect(api.read).toHaveBeenCalledTimes(2);
    t += 1;
    await s.refresh();
    expect(api.read).toHaveBeenCalledTimes(3);
  });

  it('読み直しで、サーバーの値の変更（ほかの口での変更）を取り込む', async () => {
    let t = 0;
    const { api, peek } = fakeApi({ prefs: { pluginsDevDir: '/old' } });
    const s = new DeviceSettings(deps({ api, now: () => t }).d);
    await s.start();
    expect(s.pluginsDevDir).toBe('/old');
    // CLI が サーバーの値を変えた
    const server = peek() as Record<string, unknown>;
    server.pluginsDevDir = '/new';
    t = 6_000;
    await s.refresh({ quiet: true });
    expect(s.pluginsDevDir).toBe('/new');
  });

  it('読み直しの失敗は、quiet のとき知らせない（記録だけ）', async () => {
    let t = 0;
    const reported: string[] = [];
    setSettingsErrorHandler((x) => reported.push(x));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api } = fakeApi({ prefs: {} });
    const s = new DeviceSettings(deps({ api, now: () => t }).d);
    await s.start();
    api.read.mockRejectedValueOnce(new Error('オフライン'));
    t = 6_000;
    await s.refresh({ quiet: true });
    expect(reported).toEqual([]);
    expect(warn).toHaveBeenCalled();
    api.read.mockRejectedValueOnce(new Error('オフライン'));
    t = 12_000;
    await s.refresh();
    expect(reported[0]).toContain('デバイスの設定を読めませんでした');
    warn.mockRestore();
    setSettingsErrorHandler((x) => console.error(x));
  });

  it('名前を変えたら、登録し直す', async () => {
    const { api } = fakeApi({ prefs: {} });
    const s = new DeviceSettings(deps({ api }).d);
    await s.start();
    await s.renameDevice('書斎');
    expect(api.register).toHaveBeenLastCalledWith('dev-1', '書斎');
  });
});
