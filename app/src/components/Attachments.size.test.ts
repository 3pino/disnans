// @vitest-environment jsdom
// チャットの画像の大きさは CSS が決める（全デバイス共通）。ここは、CSS へ渡す値（縦横の比・元の高さ）と、1 枚か複数かの印を確かめる。
// 実際の矩形（30vh・テーマの変数・長辺の上限）は app/scripts/feedback-ui-check.mjs（Chromium）で確かめる
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Attachments from './Attachments.svelte';
import type { Attachment } from '../lib/protocol/Attachment';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const image = (id: string, width: number | null, height: number | null): Attachment => ({ id, file_name: `${id}.png`, mime: 'image/png', size: 10, width, height, has_thumb: false, deleted: false });

function render(attachments: Attachment[]): HTMLElement[] {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Attachments, { target, props: { attachments, body: '' } });
  flushSync();
  return [...target.querySelectorAll<HTMLElement>('.attachment-image')];
}

describe('チャットの画像の大きさの入力（全デバイス共通・デバイスで分けない）', () => {
  it('1 枚: 縦横の比と元の高さを CSS へ渡し、インラインの幅・高さは付けない', () => {
    const [b] = render([image('a', 1600, 400)]);
    expect(b.classList.contains('attachment-image-single')).toBe(true);
    expect(b.style.getPropertyValue('--att-r')).toBe('4');
    expect(b.style.getPropertyValue('--att-h')).toBe('400px');
    expect(b.style.width).toBe('');
    expect(b.style.height).toBe('');
    expect(b.style.aspectRatio).toBe('4 / 1');
  });
  it('複数: 行の高さをそろえる（1 枚の印は付けない。比だけ違う）', () => {
    const boxes = render([image('a', 300, 300), image('b', 600, 300)]);
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.classList.contains('attachment-image-single')).toBe(false);
    expect(boxes.map((b) => b.style.getPropertyValue('--att-r'))).toEqual(['1', '2']);
  });
  it('寸法が分からない画像は、正方形（比 1・元の高さなし）', () => {
    const [b] = render([image('a', null, null)]);
    expect(b.style.getPropertyValue('--att-r')).toBe('1');
    expect(b.style.getPropertyValue('--att-h')).toBe('');
  });
});
