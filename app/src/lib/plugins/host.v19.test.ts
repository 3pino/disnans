// @vitest-environment jsdom
// API 19 の本体の口: 環境の読み取り（app.platform）と、画像の読み方（Linux の代わりの経路を先に）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  web: vi.fn(),
  tauri: false,
  os: '',
  linux: false,
}));
vi.mock('../call/instance.svelte', () => ({ callApi: {} }));
vi.mock('../clipboardImage', () => ({ readNativeClipboardImage: mocks.native, readClipboardImage: mocks.web }));
vi.mock('../platform', () => ({ isTauri: () => mocks.tauri, osName: () => mocks.os, isLinuxDesktop: () => mocks.linux, capabilities: () => ({}), isAndroid: () => false, isDesktop: () => true, platformInfo: () => ({}) }));

import { hostPlatform, PluginHost } from './host.svelte';

beforeEach(() => {
  mocks.native.mockReset();
  mocks.web.mockReset();
  mocks.tauri = false;
  mocks.os = '';
  mocks.linux = false;
});

describe('app.platform（読み取りのみ）', () => {
  it('Tauri・OS・Linux のデスクトップを、いまの値で返す', () => {
    mocks.tauri = true;
    mocks.os = 'linux';
    mocks.linux = true;
    expect(hostPlatform()).toEqual({ tauri: true, os: 'linux', linuxDesktop: true });
    mocks.os = 'android';
    mocks.linux = false;
    expect(hostPlatform()).toEqual({ tauri: true, os: 'android', linuxDesktop: false });
  });

  it('ブラウザーでは tauri は偽、os は空', () => {
    expect(hostPlatform()).toEqual({ tauri: false, os: '', linuxDesktop: false });
  });
});

describe('ui.clipboard.readImage（Linux の代わりの経路を先に）', () => {
  const readImage = () =>
    (new PluginHost() as unknown as { apiV19Ui(): { clipboard: { readImage(): Promise<unknown> } } }).apiV19Ui().clipboard.readImage();

  it('代わりの経路で取れたら、それを返す（通常の読み方は呼ばない）', async () => {
    const img = new Blob(['png']);
    mocks.native.mockResolvedValue(img);
    expect(await readImage()).toBe(img);
    expect(mocks.web).not.toHaveBeenCalled();
  });

  it('代わりの経路が無ければ（null）、通常の読み方へ', async () => {
    const img = new Blob(['webp']);
    mocks.native.mockResolvedValue(null);
    mocks.web.mockResolvedValue(img);
    expect(await readImage()).toBe(img);
    expect(mocks.web).toHaveBeenCalledOnce();
  });
});
