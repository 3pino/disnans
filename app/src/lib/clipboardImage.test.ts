import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClipboardImage, readNativeClipboardImage } from './clipboardImage';

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
const plugin = vi.hoisted(() => ({ readImage: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readImage: () => plugin.readImage() }));

/** Tauri のデスクトップ（Windows・Linux）のふりをする */
function asDesktop(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __DISNANS_PLATFORM__: { os: 'linux', desktop: true, android: false, capabilities: null } });
}

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
  plugin.readImage.mockReset();
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

  it('画像が無い（null）なら null。Web の経路（許可の表示が出うる）は使わない', async () => {
    asAndroid(true);
    invoke.mockResolvedValue(null);
    const read = vi.fn(async () => [item({ 'image/png': 'WEB' })]);
    setClipboard({ read });
    expect(await readClipboardImage()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('コマンドが無い・失敗したときだけ Web の経路、どちらも無ければ null', async () => {
    asAndroid(true);
    invoke.mockRejectedValue(new Error('not found'));
    setClipboard(undefined);
    expect(await readClipboardImage()).toBeNull();
  });

  it('コマンドが失敗したら、Web の経路で読める', async () => {
    asAndroid(true);
    invoke.mockRejectedValue(new Error('not found'));
    setClipboard({ read: async () => [item({ 'image/png': 'WEB' })] });
    const f = await readClipboardImage();
    expect(await f!.text()).toBe('WEB');
  });
});

describe('readClipboardImage（デスクトップの Tauri の経路）', () => {
  it('画像が無い（readImage が失敗）なら null。Web の経路は使わない（許可の表示を出さない）', async () => {
    asDesktop();
    plugin.readImage.mockRejectedValue(new Error('no image'));
    const read = vi.fn(async () => [item({ 'image/png': 'WEB' })]);
    setClipboard({ read });
    expect(await readClipboardImage()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
