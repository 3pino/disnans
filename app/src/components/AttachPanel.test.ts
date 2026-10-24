// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AttachPanel from './AttachPanel.svelte';
import { setRecentImageSource, type RecentImageSource } from '../lib/recentImages';

// 添付パネルの一覧: 読めなかったときは「空」とは別の文言を出し、再試行で読み直す
const clip = vi.hoisted(() => ({ read: vi.fn(async (): Promise<File | null> => null) }));
vi.mock('../lib/clipboardImage', () => ({ readClipboardImage: () => clip.read() }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

// 枠の幅（clientWidth）と画面の高さは、テストで決める（jsdom はレイアウトを計算しない）
const layout = vi.hoisted(() => ({ width: 0 }));

beforeEach(() => {
  // bind:clientWidth は ResizeObserver を使う（jsdom には無い）。測るのは、マウントしたときの 1 回だけでよい
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => layout.width });
  window.innerHeight = 844;
  layout.width = 0;
  localStorage.setItem('disnans.recentImages.asked', '1');
  clip.read.mockReset();
  clip.read.mockImplementation(async () => null);
  URL.createObjectURL = vi.fn(() => 'blob:clip');
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  setRecentImageSource(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

/** 描画を閉じる（同じテストの中で開き直すとき） */
async function closeNow(): Promise<void> {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
}

const noop = () => {};
async function render(source: RecentImageSource): Promise<HTMLElement> {
  setRecentImageSource(source);
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(AttachPanel, {
    target,
    props: { oncamera: noop, onimage: noop, onfile: noop, onrecent: noop, onclipboard: noop, onclose: noop },
  });
  flushSync();
  await vi.waitFor(() => expect(target!.querySelector('.attach-panel')).not.toBeNull());
  return target;
}

describe('添付パネルの最近の画像', () => {
  it('一覧が読めなかったら、空の文言ではなく読み込みの失敗を出し、再試行で読み直す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const el = await render({
      list: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return { permission: 'granted', images: [] };
      },
      requestPermission: async () => 'granted',
    });
    await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
    expect(el.textContent).toContain('最近の画像を読み込めませんでした');
    expect(el.textContent).not.toContain('最近の画像はありません');
    expect(warn).toHaveBeenCalledWith('最近の画像を読めませんでした', expect.any(Error));

    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('再試行'))!;
    retry.click();
    await vi.waitFor(() => expect(el.textContent).toContain('最近の画像はありません'));
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(calls).toBe(2);
  });

  it('読めて 0 件（許可あり）なら、空の文言を出し、失敗の文言は出さない', async () => {
    const el = await render({ list: async () => ({ permission: 'granted', images: [] }), requestPermission: async () => 'granted' });
    await vi.waitFor(() => expect(el.textContent).toContain('最近の画像はありません'));
    expect(el.textContent).not.toContain('読み込めませんでした');
  });

  it('読み込み中は「読み込み中」を出し、読めて 0 件になるまで空の文言を出さない', async () => {
    let finish: (v: { permission: 'granted'; images: never[] }) => void = () => {};
    const el = await render({
      list: () => new Promise((resolve) => (finish = resolve)),
      requestPermission: async () => 'granted',
    });
    await vi.waitFor(() => expect(el.textContent).toContain('読み込み中'));
    expect(el.textContent).not.toContain('最近の画像はありません');
    finish({ permission: 'granted', images: [] });
    await vi.waitFor(() => expect(el.textContent).toContain('最近の画像はありません'));
    expect(el.textContent).not.toContain('読み込み中');
  });

  it('ボタンの行は一覧の下に置く（一覧だけがスクロールする）', async () => {
    const el = await render({ list: async () => ({ permission: 'granted', images: [] }), requestPermission: async () => 'granted' });
    const recent = el.querySelector('.attach-panel-recent')!;
    const buttons = el.querySelector('.attach-panel-buttons')!;
    expect(recent.compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('クリップボードに画像があれば、先頭に 1 件出し、残りの最近の画像で枠を埋める（枠に入るだけ）', async () => {
    const images = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      name: `r${i}.png`,
      thumbUrl: null,
      preview: async () => 'blob:x',
      load: async () => new File(['x'], `r${i}.png`),
    }));
    const source = { list: async () => ({ permission: 'granted' as const, images }), requestPermission: async () => 'granted' as const };

    // クリップボードなし: 最近の画像をすべて（8 件は枠に入る）
    let el = await render(source);
    await vi.waitFor(() => expect(el.querySelectorAll('.attach-panel-recent-item').length).toBe(8));
    expect(el.querySelector('.attach-panel-clipboard')).toBeNull();
    await closeNow();

    // クリップボードあり: 先頭がクリップボード、続けて最近の画像（合計 9 件）
    clip.read.mockImplementation(async () => new File(['c'], 'clipboard-1.png', { type: 'image/png' }));
    el = await render(source);
    await vi.waitFor(() => expect(el.querySelectorAll('.attach-panel-recent-item').length).toBe(9));
    const first = el.querySelector('.attach-panel-recent-item')!;
    expect(first.classList.contains('attach-panel-clipboard')).toBe(true);
    expect(first.getAttribute('aria-label')).toBe('クリップボードの画像を添付');
    expect(first.querySelector('.attach-panel-clipboard-mark')).not.toBeNull();
    expect(el.querySelectorAll('.attach-panel-recent-item')[1].getAttribute('aria-label')).toBe('r0.png を添付');
    expect(clip.read).toHaveBeenCalledTimes(2);
  });

  it('枠の幅と画面の高さで、入るだけ並べる（幅 358・高さ 844 の半分 422 → 3 列 3 行の 9 件。クリップボードがあれば 1 件を除く）', async () => {
    layout.width = 358;
    const images = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      name: `r${i}.png`,
      thumbUrl: null,
      preview: async () => 'blob:x',
      load: async () => new File(['x'], `r${i}.png`),
    }));
    const source = { list: async () => ({ permission: 'granted' as const, images }), requestPermission: async () => 'granted' as const };
    let el = await render(source);
    await vi.waitFor(() => expect(el.querySelectorAll('.attach-panel-recent-item').length).toBe(9));
    expect(el.querySelector<HTMLElement>('.attach-panel-recent')!.style.gridTemplateColumns).toBe('repeat(3, 114px)');
    await closeNow();

    clip.read.mockImplementation(async () => new File(['c'], 'clipboard-1.png', { type: 'image/png' }));
    el = await render(source);
    await vi.waitFor(() => expect(el.querySelectorAll('.attach-panel-recent-item').length).toBe(9));
    expect(el.querySelector('.attach-panel-clipboard')).not.toBeNull();
  });

  it('クリップボードの画像は、パネルを開いたときに 1 回読む', async () => {
    const el = await render({ list: async () => ({ permission: 'granted', images: [] }), requestPermission: async () => 'granted' });
    await vi.waitFor(() => expect(el.textContent).toContain('最近の画像はありません'));
    expect(clip.read).toHaveBeenCalledTimes(1);
  });
});
