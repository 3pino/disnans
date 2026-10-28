import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri の API を明示的にモックする（Android は notifier の invoke、デスクトップは clipboard-manager）
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  readText: vi.fn(),
  readImage: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: h.readText, readImage: h.readImage }));

import { clipboardTextName, peekClipboard, readClipboardText } from './clipboardPaste';

/** Tauri の Android のふりをする */
function asAndroid(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __DISNANS_PLATFORM__: { os: 'android', desktop: false, android: true, capabilities: null } });
}

/** Tauri のデスクトップ（Windows・Linux）のふりをする */
function asDesktop(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, __DISNANS_PLATFORM__: { os: 'windows', desktop: true, android: false, capabilities: null } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('共有フォルダへの貼り付けのクリップボード', () => {
  it('貼り付けた文字のファイル名は、日時つきの .txt', () => {
    expect(clipboardTextName(new Date(2026, 9, 5, 7, 3, 9))).toBe('clipboard-20261005-070309.txt');
  });
});

describe('peekClipboard（Android は notifier の clipboard_peek）', () => {
  it('notifier の結果をそのまま返す', async () => {
    asAndroid();
    h.invoke.mockResolvedValue({ text: true, image: false });
    expect(await peekClipboard()).toEqual({ text: true, image: false });
    expect(h.invoke).toHaveBeenCalledWith('plugin:notifier|clipboard_peek');
  });

  it('notifier が失敗したら unknown（押したときに読む）', async () => {
    asAndroid();
    h.invoke.mockRejectedValue(new Error('not found'));
    expect(await peekClipboard()).toBe('unknown');
  });
});

describe('peekClipboard（デスクトップは clipboard-manager）', () => {
  it('文字と画像の有無を確かめる', async () => {
    asDesktop();
    h.readText.mockResolvedValue('abc');
    h.readImage.mockResolvedValue({ close: vi.fn(async () => {}) });
    expect(await peekClipboard()).toEqual({ text: true, image: true });
  });

  it('画像が無ければ image: false、文字が空なら text: false', async () => {
    asDesktop();
    h.readText.mockResolvedValue('');
    h.readImage.mockRejectedValue(new Error('no image'));
    expect(await peekClipboard()).toEqual({ text: false, image: false });
  });

  it('読めないときは unknown', async () => {
    asDesktop();
    h.readText.mockRejectedValue(new Error('denied'));
    h.readImage.mockRejectedValue(new Error('no image'));
    expect(await peekClipboard()).toEqual({ text: false, image: false });
  });
});

describe('readClipboardText', () => {
  it('Android は notifier の clipboard_text の文字を返す', async () => {
    asAndroid();
    h.invoke.mockResolvedValue({ text: 'hello' });
    expect(await readClipboardText()).toBe('hello');
    expect(h.invoke).toHaveBeenCalledWith('plugin:notifier|clipboard_text');
  });

  it('Android で文字が無ければ null', async () => {
    asAndroid();
    h.invoke.mockResolvedValue(null);
    expect(await readClipboardText()).toBeNull();
  });

  it('デスクトップは clipboard-manager の readText を使う。空や失敗は null', async () => {
    asDesktop();
    h.readText.mockResolvedValueOnce('desk');
    expect(await readClipboardText()).toBe('desk');
    h.readText.mockResolvedValueOnce('');
    expect(await readClipboardText()).toBeNull();
    h.readText.mockRejectedValueOnce(new Error('denied'));
    expect(await readClipboardText()).toBeNull();
  });
});
