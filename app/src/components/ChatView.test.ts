// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatView from './ChatView.svelte';

// Linux のネイティブのドロップ（パス）を、チャットの中で一番手前にあるものへ落としたときだけ添付する。
// 矩形だけでは、前に出ているエクスプローラーや画面の下のチャットも当たるため、点の一番手前の要素で決める。
type DropEvent = { type: 'enter' | 'over' | 'drop' | 'leave'; paths: string[]; position: { x: number; y: number } | null };

const h = vi.hoisted(() => ({
  handler: null as null | ((ev: DropEvent) => void),
  read: vi.fn(async (_paths: string[]) => ({ files: [] as File[], failed: [] as string[] })),
}));
vi.mock('../lib/dropFiles', async (orig) => ({
  ...(await orig<typeof import('../lib/dropFiles')>()),
  listenNativeDrop: async (fn: (ev: DropEvent) => void) => {
    h.handler = fn;
    return () => {};
  },
  readDroppedFiles: h.read,
}));
vi.mock('../lib/platform', async (orig) => ({
  ...(await orig<typeof import('../lib/platform')>()),
  isLinuxDesktop: () => true,
}));
vi.mock('./MessageList.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./SearchResults.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./Composer.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));

const RECT = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
const POINT = { x: 10, y: 10 };

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
/** 点の位置で一番手前にある要素（テストごとに差し替える。jsdom には無いので置き換える） */
let front: Element | null = null;
const originalFromPoint = (document as Document & { elementFromPoint?: unknown }).elementFromPoint;

beforeEach(() => {
  h.read.mockClear();
  h.handler = null;
  front = null;
  (document as Document & { elementFromPoint: unknown }).elementFromPoint = () => front;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ChatView, { target, props: { placeholder: 'テスト' } });
  flushSync();
});

afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  document.querySelectorAll('.file-explorer-test').forEach((el) => el.remove());
  (document as Document & { elementFromPoint?: unknown }).elementFromPoint = originalFromPoint;
  vi.restoreAllMocks();
});

const chat = (): HTMLElement => target!.querySelector<HTMLElement>('.chat-view')!;
/** チャットの外にある、前に出ているエクスプローラー（の代わり） */
function frontExplorer(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'file-explorer-test';
  document.body.appendChild(el);
  return el;
}
const overlay = (): Element | null => target!.querySelector('.chat-view-drop-overlay');

describe('Linux のネイティブのドロップは、チャットの一番手前に落ちたものだけ添付する', () => {
  it('チャットの一番手前へ落とすと、添付として読む', async () => {
    front = chat();
    h.handler!({ type: 'drop', paths: ['/x/a.png'], position: POINT });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledWith(['/x/a.png']));
  });

  it('前に出ているエクスプローラー（チャットの外）へ落としたら、チャットへ添付しない', async () => {
    front = frontExplorer();
    h.handler!({ type: 'drop', paths: ['/x/a.png'], position: POINT });
    await Promise.resolve();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('チャットの矩形の中でも、一番手前が別の要素なら添付しない（前に出ているものの下のチャット）', async () => {
    front = document.body;
    h.handler!({ type: 'drop', paths: ['/x/a.png'], position: POINT });
    await Promise.resolve();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('ドラッグ中は、一番手前がチャットのときだけ受け入れの幕を出す（外へ出たら消す）', async () => {
    front = chat();
    h.handler!({ type: 'over', paths: [], position: POINT });
    flushSync();
    expect(overlay()).not.toBeNull();

    front = frontExplorer();
    h.handler!({ type: 'over', paths: [], position: POINT });
    flushSync();
    expect(overlay()).toBeNull();

    h.handler!({ type: 'leave', paths: [], position: null });
    flushSync();
    expect(overlay()).toBeNull();
  });

  it('位置の無いドロップ（矩形の外）は添付しない', async () => {
    front = chat();
    h.handler!({ type: 'drop', paths: ['/x/a.png'], position: null });
    await Promise.resolve();
    expect(h.read).not.toHaveBeenCalled();
  });
});
