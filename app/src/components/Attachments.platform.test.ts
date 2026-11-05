// @vitest-environment jsdom
// 画像の高さの上限（30vh）は Android だけ。デスクトップは従来どおり上限なし
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Attachments from './Attachments.svelte';
import type { Attachment } from '../lib/protocol/Attachment';

const platform = vi.hoisted(() => ({ android: true }));
vi.mock('../lib/platform', async (orig) => ({ ...(await orig<typeof import('../lib/platform')>()), isAndroid: () => platform.android }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const img: Attachment = { id: 'i1', file_name: 'a.png', mime: 'image/png', size: 10, width: 10, height: 10, has_thumb: false, deleted: false };

function render(): HTMLElement {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(Attachments, { target, props: { attachments: [img], body: '' } });
  flushSync();
  return target;
}

describe('チャットの画像の高さの上限（Android だけ 30vh・縦横の比は保つ）', () => {
  it('Android では、枠の幅と高さを CSS で比例して縮める（インラインの幅・高さは付けず、寸法を変数で渡す）', () => {
    platform.android = true;
    const b = render().querySelector<HTMLElement>('.attachment-image')!;
    expect(b.classList.contains('attachment-image-android')).toBe(true);
    expect(b.style.width).toBe('');
    expect(b.style.height).toBe('');
    expect(b.style.getPropertyValue('--att-w')).toBe('10');
    expect(b.style.getPropertyValue('--att-h')).toBe('10');
    expect(b.style.aspectRatio).toBe('10 / 10');
  });
  it('デスクトップでは、インラインの幅・高さのまま（上限の印も変数も付かない）', () => {
    platform.android = false;
    const b = render().querySelector<HTMLElement>('.attachment-image')!;
    expect(b.classList.contains('attachment-image-android')).toBe(false);
    expect(b.style.width).toBe('10px');
    expect(b.style.height).toBe('10px');
    expect(b.style.getPropertyValue('--att-w')).toBe('');
  });
});
