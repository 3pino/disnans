// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import AttachPanel from './AttachPanel.svelte';
import { setRecentImageSource, type RecentImageSource } from '../lib/recentImages';

// 添付パネルの一覧: 読めなかったときは「空」とは別の文言を出し、再試行で読み直す
vi.mock('../lib/clipboardImage', () => ({ readClipboardImage: async () => null }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  localStorage.setItem('disnans.recentImages.asked', '1');
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  setRecentImageSource(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

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
});
