// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 添付・共有フォルダのファイルの保存（Tauri では直接保存して、トーストで知らせる）。invoke は差し替える。
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));

import { setServerUrl } from './config';
import { downloadFailureText, downloadFile, downloadPath, interceptDownload, openFailureText } from './download';
import { ui } from './stores/ui.svelte';

const SERVER = 'https://disnans.example.ts.net';
const FILE = `${SERVER}/api/files/01HXABC`;
const SHARED = `${SERVER}/api/shared/docs/a%20b.pdf`;

/** Tauri の WebView のふり（isTauri は __TAURI_INTERNALS__ で決まる） */
function tauri(on: boolean): void {
  if (on) (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.invoke.mockReset();
  setServerUrl(SERVER);
  tauri(true);
  ui.toasts = [];
});
afterEach(() => {
  tauri(false);
  setServerUrl(null);
  vi.restoreAllMocks();
});

/** 投げた toast を待つ（invoke の後ろで出る） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('downloadPath: 保存できる API のパスだけを取る', () => {
  it('このサーバーの /api/files と /api/shared は、パスを返す（dev_user は外す）', () => {
    expect(downloadPath(FILE, SERVER)).toBe('/api/files/01HXABC');
    expect(downloadPath(SHARED, SERVER)).toBe('/api/shared/docs/a%20b.pdf');
    expect(downloadPath(`${FILE}?dev_user=alice`, SERVER)).toBe('/api/files/01HXABC');
  });

  it('別のサーバー・別の経路・余分なクエリ・フラグメントは取らない', () => {
    expect(downloadPath('https://evil.example/api/files/x', SERVER)).toBeNull();
    expect(downloadPath(`${SERVER}/api/me`, SERVER)).toBeNull();
    expect(downloadPath(`${SERVER}/api/files/x?token=1`, SERVER)).toBeNull();
    expect(downloadPath(`${FILE}#x`, SERVER)).toBeNull();
    expect(downloadPath('not a url', SERVER)).toBeNull();
    expect(downloadPath(FILE, '')).toBeNull();
  });

  it('サーバーに接頭のパスがあっても、その中の API を取る', () => {
    expect(downloadPath('https://h.example/disnans/api/files/x', 'https://h.example/disnans')).toBe('/api/files/x');
    expect(downloadPath('https://h.example/other/api/files/x', 'https://h.example/disnans')).toBeNull();
  });
});

describe('downloadFile（Tauri）', () => {
  it('直接保存して、「ダウンロードしました」と「開く」のトーストを出す', async () => {
    h.invoke.mockResolvedValueOnce({ handle: 'dl1', name: 'a (2).pdf' });
    await downloadFile({ url: SHARED, name: 'a.pdf' });
    expect(h.invoke).toHaveBeenCalledWith('api_download', {
      args: { server: SERVER, devUser: null, path: '/api/shared/docs/a%20b.pdf', name: 'a.pdf' },
    });
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0].text).toBe('ダウンロードしました: a (2).pdf');
    expect(ui.toasts[0].kind).toBe('info');
    expect(ui.toasts[0].action?.label).toBe('開く');
  });

  it('「開く」を押すと、そのハンドルで api_download_open を呼ぶ', async () => {
    h.invoke.mockResolvedValueOnce({ handle: 'dl7', name: 'x.png' });
    await downloadFile({ url: FILE, name: 'x.png' });
    h.invoke.mockResolvedValueOnce(undefined);
    ui.toasts[0].action!.run();
    await flush();
    expect(h.invoke).toHaveBeenLastCalledWith('api_download_open', { args: { handle: 'dl7' } });
  });

  it('開けなかったら、エラーのトーストを出す', async () => {
    h.invoke.mockResolvedValueOnce({ handle: 'dl8', name: 'x.png' });
    await downloadFile({ url: FILE, name: 'x.png' });
    h.invoke.mockRejectedValueOnce({ code: 'open_failed', message: 'x' });
    ui.toasts[0].action!.run();
    await flush();
    expect(ui.toasts.at(-1)?.kind).toBe('error');
    expect(ui.toasts.at(-1)?.text).toBe('ファイルを開けませんでした');
  });

  it('失敗したら、短い日本語の理由をエラーのトーストで出す（トーストに「開く」は付けない）', async () => {
    h.invoke.mockRejectedValueOnce({ code: 'no_space', message: '保存先の空き容量が足りません' });
    await downloadFile({ url: FILE, name: 'big.bin' });
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0].kind).toBe('error');
    expect(ui.toasts[0].text).toBe('ダウンロードできませんでした: 保存先の空き容量が足りません');
    expect(ui.toasts[0].action).toBeUndefined();
  });

  it('同じパスの取得中は、2 回目を受けない（ダブルタップ）', async () => {
    let finish: (v: unknown) => void = () => {};
    h.invoke.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const first = downloadFile({ url: FILE, name: 'x.png' });
    await downloadFile({ url: FILE, name: 'x.png' });
    await flush();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    finish({ handle: 'dl2', name: 'x.png' });
    await first;
    // 終わったら、もう一度押せる
    h.invoke.mockResolvedValueOnce({ handle: 'dl3', name: 'x (2).png' });
    await downloadFile({ url: FILE, name: 'x.png' });
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it('このサーバー以外の URL は、ブラウザーの既定に任せる（invoke しない）', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloadFile({ url: 'https://other.example/api/files/x', name: 'x.png' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('downloadFile（ブラウザーの開発用）', () => {
  it('Tauri でなければ、従来どおり <a download> で保存する', async () => {
    tauri(false);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloadFile({ url: FILE, name: 'x.png' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(ui.toasts).toHaveLength(0);
  });
});

describe('interceptDownload（押しの横取り）', () => {
  function click(init: MouseEventInit = {}): MouseEvent {
    return new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  }

  it('Tauri で、このサーバーの左クリックは、既定を止めて直接保存する', async () => {
    h.invoke.mockResolvedValueOnce({ handle: 'dl9', name: 'x.png' });
    const ev = click();
    expect(interceptDownload(ev, { url: FILE, name: 'x.png' })).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(h.invoke).toHaveBeenCalledWith('api_download', expect.anything());
  });

  it('修飾キー付き・中クリック・右クリックは、既定のまま（止めない）', () => {
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { button: 2 }]) {
      const ev = click(init);
      expect(interceptDownload(ev, { url: FILE, name: 'x.png' })).toBe(false);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('ブラウザーでは止めない（右クリックや既定の保存が残る）', () => {
    tauri(false);
    const ev = click();
    expect(interceptDownload(ev, { url: FILE, name: 'x.png' })).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('このサーバー以外の URL は止めない', () => {
    const ev = click();
    expect(interceptDownload(ev, { url: 'https://other.example/api/files/x', name: 'x.png' })).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('失敗の文', () => {
  it('code ごとに、短い理由を出す（不明なものは、理由を付けずに出す）', () => {
    expect(downloadFailureText({ code: 'network', message: 'x' })).toBe('ダウンロードできませんでした: ネットワークに接続できませんでした');
    expect(downloadFailureText({ code: 'too_large', message: 'x' })).toBe('ダウンロードできませんでした: 大きすぎるため保存しませんでした');
    expect(downloadFailureText({ code: 'permission', message: 'x' })).toBe('ダウンロードできませんでした: 保存先に書き込めませんでした');
    expect(downloadFailureText({ code: 'no_space', message: 'x' })).toBe('ダウンロードできませんでした: 保存先の空き容量が足りません');
    expect(downloadFailureText({ code: 'not_found', status: 404, message: 'x' })).toBe('ダウンロードできませんでした: ファイルが見つかりません');
    expect(downloadFailureText({ code: 'http_500', status: 500, message: 'x' })).toBe('ダウンロードできませんでした: サーバーから受け取れませんでした');
    expect(downloadFailureText('oops')).toBe('ダウンロードできませんでした');
  });

  it('開けなかったときの文', () => {
    expect(openFailureText({ code: 'not_found' })).toBe('ファイルが見つかりません（もう一度ダウンロードしてください）');
    expect(openFailureText({ code: 'open_failed' })).toBe('ファイルを開けませんでした');
  });
});
