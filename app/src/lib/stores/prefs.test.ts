// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  prefs: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  setPrefs: vi.fn(async (p: Record<string, unknown>) => p),
}));
vi.mock('../api', () => ({ api: apiMock }));

const { Prefs } = await import('./prefs.svelte');
const { DEFAULT_NAV_ITEMS } = await import('../navBar');

/** 版の印のある「＋」メニュー（移行の保存を起こさないため） */
const BASE = { composerMenu: { v: 2, order: [], hidden: [] } };

const LOAD = (p: InstanceType<typeof Prefs>) => (p as unknown as { load(): Promise<void> }).load();

beforeEach(() => {
  localStorage.clear();
  apiMock.prefs.mockReset();
  apiMock.setPrefs.mockReset();
  apiMock.setPrefs.mockImplementation(async (p: Record<string, unknown>) => p);
});

describe('Prefs（ユーザーごとの設定）', () => {
  it('サーバーに無い項目だけ、以前の端末の値を一度取り込む（ある値は上書きしない）', async () => {
    localStorage.setItem('disnans.theme', 'dark');
    localStorage.setItem('disnans.navBarItems', JSON.stringify(['chat', 'settings', 'app:open-settings']));
    apiMock.prefs.mockResolvedValue({ ...BASE, theme: 'light' });
    const p = new Prefs();
    await LOAD(p);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved.theme).toBe('light');
    expect(saved.navBarItems).toEqual(expect.arrayContaining(['chat', 'settings', 'app:open-settings']));
    expect(p.theme).toBe('light');
  });

  it('サーバーに値があれば、以前の端末の値は使わない（保存もしない）', async () => {
    localStorage.setItem('disnans.theme', 'dark');
    apiMock.prefs.mockResolvedValue({ ...BASE, theme: 'light', joinMuted: true });
    const p = new Prefs();
    await LOAD(p);
    expect(p.theme).toBe('light');
    expect(apiMock.setPrefs).not.toHaveBeenCalled();
  });

  it('通話のユーザーごとの値を、以前の保存先から取り込む', async () => {
    localStorage.setItem('disnans.call.settings', JSON.stringify({ joinMuted: true, micVolume: 0.5, inputId: 'mic1' }));
    apiMock.prefs.mockResolvedValue({ ...BASE });
    const p = new Prefs();
    await LOAD(p);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved).toMatchObject({ joinMuted: true, micVolume: 0.5 });
    // 機器の項目はユーザーごとには入れない
    expect(saved).not.toHaveProperty('inputId');
    expect(p.callUser.joinMuted).toBe(true);
  });

  it('テーマ・ナビの既定と、知らない値の扱い', async () => {
    apiMock.prefs.mockResolvedValue({ ...BASE, theme: 'blue', navBarItems: 'x', customTheme: '' });
    const p = new Prefs();
    await LOAD(p);
    expect(p.theme).toBe('system');
    expect(p.customTheme).toBeNull();
    expect(p.navBarItems).toEqual(DEFAULT_NAV_ITEMS);
  });

  it('setTheme・setCustomTheme は保存し、手元にもすぐ反映する', async () => {
    apiMock.prefs.mockResolvedValue({ ...BASE });
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
    apiMock.prefs.mockResolvedValue({ ...BASE });
    const p = new Prefs();
    await LOAD(p);
    p.setCallUser({ limitDb: -12, inputId: 'x' } as never);
    await vi.waitFor(() => expect(apiMock.setPrefs).toHaveBeenCalled());
    const saved = apiMock.setPrefs.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(saved).toMatchObject({ limitDb: -12 });
    expect(saved).not.toHaveProperty('inputId');
  });
});
