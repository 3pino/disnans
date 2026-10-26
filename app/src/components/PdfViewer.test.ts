// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Lightbox from './Lightbox.svelte';
import { ui } from '../lib/stores/ui.svelte';

// PDF のプレビュー（Lightbox の kind: 'pdf'）。pdf.js は差し替える（ページの数と大きさだけ返す）
const h = vi.hoisted(() => ({
  getDocument: vi.fn((_opts: { url: string; isEvalSupported: boolean }) => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      }),
    }),
    destroy: async () => {},
  })),
}));
vi.mock('../lib/pdfjs', () => ({ loadPdfjs: async () => ({ getDocument: h.getDocument }) }));

let instance: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  // bind:clientWidth は ResizeObserver を使う（jsdom には無い）
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  ui.lightbox = null;
  document.body.innerHTML = '';
});

describe('PDF のプレビュー', () => {
  it('ページを縦に並べ、ページ数と拡大・縮小を出す。PDF の中のスクリプトは評価しない', async () => {
    instance = mount(Lightbox, { target: document.body });
    ui.lightbox = { src: 'http://s/api/shared/a.pdf', alt: 'a.pdf', downloadUrl: 'http://s/api/shared/a.pdf', kind: 'pdf' };
    flushSync();
    await vi.waitFor(() => expect(document.querySelectorAll('.pdf-viewer-page')).toHaveLength(3));
    expect(h.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://s/api/shared/a.pdf', isEvalSupported: false }));
    expect(document.querySelector('.pdf-viewer-count')?.textContent).toBe('3 ページ');
    // 画像の舞台は出さない。ファイル名・ダウンロード・閉じるは画像と同じ
    expect(document.querySelector('.lightbox-image')).toBeNull();
    expect(document.querySelector('.lightbox-file-name')?.textContent).toBe('a.pdf');
    const zoomOut = document.querySelector<HTMLButtonElement>('button[aria-label="縮小"]')!;
    const zoomIn = document.querySelector<HTMLButtonElement>('button[aria-label="拡大"]')!;
    expect(zoomOut.disabled).toBe(true);
    zoomIn.click();
    flushSync();
    expect(zoomOut.disabled).toBe(false);
  });

  it('画像（kind なし）は、これまでどおり画像を出す', () => {
    instance = mount(Lightbox, { target: document.body });
    ui.lightbox = { src: 'x.png', alt: 'x.png', downloadUrl: 'x.png' };
    flushSync();
    expect(document.querySelector('.lightbox-image')).not.toBeNull();
    expect(document.querySelector('.pdf-viewer')).toBeNull();
  });
});
