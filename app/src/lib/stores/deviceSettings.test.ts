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
    list: vi.fn(async () => []),
    remove: vi.fn(async (_id: string) => {}),
  };
  return { api, peek: () => server };
}

function deps(over: Partial<DeviceDeps> & { api?: DeviceApi; local?: ReturnType<typeof memory> } = {}) {
  const local = over.local ?? memory();
  const d: DeviceDeps = {
    api: over.api ?? fakeApi().api,
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

describe('DeviceSettings（手元の値: キャッシュと取り込み。起動の前・オフラインでも値が出る）', () => {
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
  it('自デバイスの名前変更が失敗したら呼び出し側へ返し、次回再送されるローカル名も変えない', async () => {
    const { api } = fakeApi();
    const local = memory({ [DEVICE_NAME_KEY]: '旧名' });
    const s = new DeviceSettings(deps({ api, local }).d);
    await s.start();
    api.register.mockRejectedValueOnce(new Error('offline'));
    await expect(s.renameDevice('新名')).rejects.toThrow('offline');
    expect(s.deviceName()).toBe('旧名');
    expect(local.m.get(DEVICE_NAME_KEY)).toBe('旧名');
  });

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

describe('DeviceSettings（読み込みの途中の変更を守る・synced）', () => {
  it('読めるまで synced は false。読めたら true（読めなければ false のまま）', async () => {
    const { api } = fakeApi({ saved: false });
    const { d } = deps({ api });
    const s = new DeviceSettings(d);
    expect(s.synced).toBe(false);
    await s.start();
    expect(s.synced).toBe(true);

    const bad = fakeApi();
    bad.api.read.mockRejectedValueOnce(new Error('オフライン'));
    const s2 = new DeviceSettings(deps({ api: bad.api }).d);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await s2.start();
    expect(s2.ready).toBe(true);
    expect(s2.synced).toBe(false);
    spy.mockRestore();
  });

  it('読んでいるあいだに変えた値を、古いサーバーの値で戻さない（変えた値が送られる）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, peek } = fakeApi({ prefs: { inputId: 'old', hideNavigationBar: false, orientation: 'auto', pluginsDisabled: [], pluginsDevDir: null } });
    const realRead = api.read;
    api.read.mockImplementationOnce(async (id: string) => {
      const v = await realRead(id);
      await gate;
      return v;
    });
    const { d } = deps({ api });
    const s = new DeviceSettings(d);
    const started = s.start();
    // 読んでいるあいだに、利用者が変える
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());
    s.set('screenShare', { fps: 20, quality: 'p1080', color: 'gray' });
    release();
    await started;
    expect(s.raw.screenShare).toEqual({ fps: 20, quality: 'p1080', color: 'gray' });
    await vi.waitFor(() => expect(peek()).toMatchObject({ screenShare: { fps: 20, quality: 'p1080', color: 'gray' } }));
  });

  it('読み直しも、書き込みの途中・読むあいだの変更では上書きしない', async () => {
    const { api } = fakeApi({ prefs: { inputId: 'a' } });
    const { d } = deps({ api, now: () => 1_000_000 });
    const s = new DeviceSettings(d);
    await s.start();
    s.set('inputId', 'changed-locally');
    await s.refresh();
    expect(s.inputId).toBe('changed-locally');
  });
});

describe('DeviceSettings（同期の前の変更は、サーバーの値を消さない）', () => {
  it('読み終える前に、利用者が一項目だけ変えても、既定の全体は送らない。サーバーの入力機器と知らない項目は残る', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, peek } = fakeApi({ prefs: { inputId: 'remoteMic', futureKey: { keep: true } } });
    const realRead = api.read;
    api.read.mockImplementationOnce(async (id: string) => {
      const v = await realRead(id);
      await gate;
      return v;
    });
    // 手元の値（キャッシュ）が無い。既定の値だけがある状態で、読み終える前に変える
    const { d, local } = deps({ api });
    const s = new DeviceSettings(d);
    expect(s.inputId).toBe('');
    const started = s.start();
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());
    s.set('screenShare', { fps: 20, quality: 'p1080', color: 'gray' });
    // 読み終えるまで、何も送っていない（既定の全体を先に送らない）
    expect(api.write).not.toHaveBeenCalled();
    release();
    await started;

    expect(api.write).toHaveBeenCalledTimes(1);
    const sent = api.write.mock.calls[0][1];
    expect(sent).toMatchObject({ inputId: 'remoteMic', futureKey: { keep: true }, screenShare: { fps: 20, quality: 'p1080', color: 'gray' } });
    expect(peek()).toMatchObject({ inputId: 'remoteMic', futureKey: { keep: true } });
    // 手元の値も、サーバーの入力機器を反映する
    expect(s.inputId).toBe('remoteMic');
    expect(s.raw.futureKey).toEqual({ keep: true });
    expect(s.synced).toBe(true);
    expect(JSON.parse(local.m.get(DEVICE_CACHE_KEY) ?? '{}').inputId).toBe('remoteMic');
  });

  it('読み終える前に入力機器そのものを変えたら、その変更が勝つ（ほかのサーバーの項目は残る）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, peek } = fakeApi({ prefs: { inputId: 'remoteMic', orientation: 'portrait' } });
    const realRead = api.read;
    api.read.mockImplementationOnce(async (id: string) => {
      const v = await realRead(id);
      await gate;
      return v;
    });
    const s = new DeviceSettings(deps({ api }).d);
    const started = s.start();
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());
    s.set('inputId', 'localMic');
    release();
    await started;
    expect(peek()).toMatchObject({ inputId: 'localMic', orientation: 'portrait' });
  });

  it('最初の読みが失敗したら、変更は覚えたまま。次の読み直しで、サーバーの値に重ねて送る', async () => {
    const { api, peek } = fakeApi({ prefs: { inputId: 'remoteMic' } });
    api.read.mockRejectedValueOnce(new Error('オフライン'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new DeviceSettings(deps({ api, now: () => 1_000_000 }).d);
    await s.start();
    expect(s.synced).toBe(false);
    s.set('screenShare', { fps: 5, quality: 'p480', color: 'full' });
    // 同期していないあいだは送らない
    expect(api.write).not.toHaveBeenCalled();
    // 次の読み直し（サーバーは届いた。失敗は一度だけなので、次は普通に読める）
    await s.refresh();
    expect(s.synced).toBe(true);
    expect(peek()).toMatchObject({ inputId: 'remoteMic', screenShare: { fps: 5, quality: 'p480', color: 'full' } });
    spy.mockRestore();
  });
});
