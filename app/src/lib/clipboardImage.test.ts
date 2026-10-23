import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClipboardImage, readNativeClipboardImage } from './clipboardImage';

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

/** Tauri の中（Android）のふりをする。false なら素のブラウザ */
function asAndroid(on: boolean): void {
  vi.stubGlobal('window', on ? { __TAURI_INTERNALS__: {}, __DISNANS_PLATFORM__: { os: 'android', desktop: false, android: true, capabilities: null } } : {});
}

/** navigator.clipboard を差し替える（テストの中だけ） */
function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  vi.unstubAllGlobals();
  invoke.mockReset();
});

/** types と getType だけを持つ ClipboardItem の代わり */
function item(types: Record<string, string>) {
  return {
    types: Object.keys(types),
    getType: async (t: string) => {
      if (!(t in types)) throw new Error('no type');
      return new Blob([types[t]], { type: t });
    },
  };
}

describe('readClipboardImage（Web の経路）', () => {
  it('Clipboard API が無ければ null', async () => {
    asAndroid(false);
    setClipboard(undefined);
    expect(await readClipboardImage()).toBeNull();
  });

  it('読めない（許可が無い）なら null', async () => {
    asAndroid(false);
    setClipboard({ read: async () => Promise.reject(new Error('NotAllowedError')) });
    expect(await readClipboardImage()).toBeNull();
  });

  it('画像が無い（テキストだけ）なら null', async () => {
    asAndroid(false);
    setClipboard({ read: async () => [item({ 'text/plain': 'x' })] });
    expect(await readClipboardImage()).toBeNull();
  });

  it('画像があれば File にする（png を優先し、拡張子と型をつける）', async () => {
    asAndroid(false);
    setClipboard({ read: async () => [item({ 'text/html': '<b>x</b>', 'image/png': 'PNG', 'image/jpeg': 'JPG' })] });
    const f = await readClipboardImage();
    expect(f).not.toBeNull();
    expect(f!.type).toBe('image/png');
    expect(f!.name).toMatch(/^clipboard-\d+\.png$/);
    expect(await f!.text()).toBe('PNG');
  });

  it('jpeg の拡張子は jpg', async () => {
    asAndroid(false);
    setClipboard({ read: async () => [item({ 'image/jpeg': 'JPG' })] });
    const f = await readClipboardImage();
    expect(f!.name).toMatch(/\.jpg$/);
  });
});

describe('readNativeClipboardImage（貼り付けの経路）', () => {
  it('Linux の Tauri 以外では null（Web の経路は使わない）', async () => {
    asAndroid(false);
    setClipboard({ read: async () => [item({ 'image/png': 'PNG' })] });
    expect(await readNativeClipboardImage()).toBeNull();
  });
});

describe('readClipboardImage（Android の経路）', () => {
  it('notifier の clipboard_image の結果を File にする（Web より先）', async () => {
    asAndroid(true);
    invoke.mockResolvedValue({ name: 'shot.png', mime: 'image/png', data: btoa('PNG') });
    setClipboard({ read: async () => [item({ 'image/jpeg': 'JPG' })] });
    const f = await readClipboardImage();
    expect(invoke.mock.calls[0]?.[0]).toBe('plugin:notifier|clipboard_image');
    expect(f!.name).toBe('shot.png');
    expect(f!.type).toBe('image/png');
    expect(await f!.text()).toBe('PNG');
  });

  it('画像が無い（null）なら Web の経路に落ちる', async () => {
    asAndroid(true);
    invoke.mockResolvedValue(null);
    setClipboard({ read: async () => [item({ 'image/png': 'WEB' })] });
    const f = await readClipboardImage();
    expect(await f!.text()).toBe('WEB');
  });

  it('コマンドが無い・失敗したら Web の経路、どちらも無ければ null', async () => {
    asAndroid(true);
    invoke.mockRejectedValue(new Error('not found'));
    setClipboard(undefined);
    expect(await readClipboardImage()).toBeNull();
  });
});
