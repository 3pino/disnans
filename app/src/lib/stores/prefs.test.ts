// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  prefs: vi.fn(async (): Promise<{ raw: Record<string, unknown>; view: Record<string, unknown> }> => ({ raw: {}, view: {} })),
  setPrefs: vi.fn(async (p: Record<string, unknown>) => ({ raw: p, view: p })),
}));
vi.mock('../api', () => ({ api: apiMock }));

const { Prefs } = await import('./prefs.svelte');
const { DEFAULT_NAV_ITEMS } = await import('../navBar');
/** Rust を通さない結果（raw はそのまま、view は既定で埋めたもの）。表示の値は Rust の正規化が決める */
const { prefsResultOf: res } = await import('../settingsModel');

/** 版の印のある「＋」メニュー（移行の保存を起こさないため） */
const BASE = { composerMenu: { v: 3, order: [], hidden: [] } };

const LOAD = (p: InstanceType<typeof Prefs>) => (p as unknown as { load(): Promise<void> }).load();

beforeEach(() => {
  localStorage.clear();
  apiMock.prefs.mockReset();
  apiMock.setPrefs.mockReset();
  apiMock.setPrefs.mockImplementation(async (p: Record<string, unknown>) => res(p));
});

describe('Prefs（ユーザーごとの設定）', () => {
  it('読み直し（refresh）はサーバーの値を取り込み、間隔（5 秒）の内は読まない。接続前・保存中も読まない', async () => {
    let t = 0;
    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'light' }));
    const p = new Prefs(() => t);
    await p.refresh(); // 接続を始める前は何もしない
    expect(apiMock.prefs).not.toHaveBeenCalled();
    p.start(); // client は未接続なので、ここでは読まない
    await LOAD(p);
    expect(apiMock.prefs).toHaveBeenCalledTimes(1);

    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'dark' }));
    await p.refresh(); // 最初の読み直しは通る
    expect(apiMock.prefs).toHaveBeenCalledTimes(2);
    expect(p.theme).toBe('dark');
    t = 4_999;
    await p.refresh(); // 間隔の内
    expect(apiMock.prefs).toHaveBeenCalledTimes(2);
    t = 5_000;
    await p.refresh();
    expect(apiMock.prefs).toHaveBeenCalledTimes(3);
  });

  it('保存の途中の読み直しは、サーバーの古い値で上書きしない', async () => {
    apiMock.prefs.mockResolvedValue(res({ ...BASE }));
    let t = 0;
    const p = new Prefs(() => t);
    p.start();
    await LOAD(p);
    let release!: (v: { raw: Record<string, unknown>; view: Record<string, unknown> }) => void;
    apiMock.setPrefs.mockImplementationOnce(() => new Promise((r) => (release = r)));
    p.setTheme('dark');
    t = 10_000;
    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'light' }));
    await p.refresh();
    expect(p.theme).toBe('dark');
    release(res({ ...BASE, theme: 'dark' }));
  });

  it('ほかの読み直しの失敗は記録だけ（設定の値はそのまま）', async () => {
    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'light' }));
    let t = 0;
    const p = new Prefs(() => t);
    p.start();
    await LOAD(p);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiMock.prefs.mockRejectedValueOnce(new Error('オフライン'));
    t = 6_000;
    await p.refresh();
    expect(p.theme).toBe('light');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('サーバーに無い項目だけ、以前のデバイスの値を一度取り込む（ある値は上書きしない）', async () => {
    localStorage.setItem('disnans.theme', 'dark');
    localStorage.setItem('disnans.navBarItems', JSON.stringify(['chat', 'settings', 'app:open-settings']));
    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'light' }));
    const p = new Prefs();
    await LOAD(p);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved.theme).toBe('light');
    expect(saved.navBarItems).toEqual(expect.arrayContaining(['chat', 'settings', 'app:open-settings']));
    expect(p.theme).toBe('light');
  });

  it('サーバーに値があれば、以前のデバイスの値は使わない（保存もしない）', async () => {
    localStorage.setItem('disnans.theme', 'dark');
    apiMock.prefs.mockResolvedValue(res({ ...BASE, theme: 'light', joinMuted: true }));
    const p = new Prefs();
    await LOAD(p);
    expect(p.theme).toBe('light');
    expect(apiMock.setPrefs).not.toHaveBeenCalled();
  });

  it('通話のユーザーごとの値を、以前の保存先から取り込む', async () => {
    localStorage.setItem('disnans.call.settings', JSON.stringify({ joinMuted: true, micVolume: 0.5, inputId: 'mic1' }));
    apiMock.prefs.mockResolvedValue(res({ ...BASE }));
    const p = new Prefs();
    await LOAD(p);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved).toMatchObject({ joinMuted: true, micVolume: 0.5 });
    // 機器の項目はユーザーごとには入れない
    expect(saved).not.toHaveProperty('inputId');
    expect(p.callUser.joinMuted).toBe(true);
  });

  it('表示は view の値（Rust が正規化したもの）をそのまま読む。足りない項目は既定で埋まる', async () => {
    apiMock.prefs.mockResolvedValue({ raw: { ...BASE }, view: { theme: 'dark', customTheme: null, navBarItems: DEFAULT_NAV_ITEMS, composerMenu: { order: [], hidden: [] } } });
    const p = new Prefs();
    await LOAD(p);
    expect(p.theme).toBe('dark');
    expect(p.customTheme).toBeNull();
    expect(p.navBarItems).toEqual(DEFAULT_NAV_ITEMS);
    expect(p.messageLayout).toBe('list');
  });

  it('保存するときは raw（サーバーの元のオブジェクト）に変えた項目を足す。view の既定は書き戻さない', async () => {
    apiMock.prefs.mockResolvedValue({ raw: { ...BASE, futureKey: 1 }, view: { ...res({}).view, futureKey: 1 } });
    const p = new Prefs();
    await LOAD(p);
    p.setTheme('light');
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved).toMatchObject({ theme: 'light', futureKey: 1 });
    expect(saved).not.toHaveProperty('limitDb');
  });

  it('setTheme・setCustomTheme は保存し、手元にもすぐ反映する', async () => {
    apiMock.prefs.mockResolvedValue(res({ ...BASE }));
    const p = new Prefs();
    await LOAD(p);
    const fn = vi.fn();
    p.subscribe(fn);
    p.setTheme('dark');
    p.setCustomTheme('midnight');
    expect(p.theme).toBe('dark');
    expect(p.customTheme).toBe('midnight');
    expect(fn).toHaveBeenCalled();
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalledTimes(2));
  });

  it('setCallUser は機器の項目を無視し、ユーザーごとの項目だけ保存する', async () => {
    apiMock.prefs.mockResolvedValue(res({ ...BASE }));
    const p = new Prefs();
    await LOAD(p);
    p.setCallUser({ limitDb: -12, inputId: 'x' } as never);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved).toMatchObject({ limitDb: -12 });
    expect(saved).not.toHaveProperty('inputId');
  });
});
