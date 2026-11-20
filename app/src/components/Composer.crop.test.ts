// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Composer from './Composer.svelte';

// 切り抜きの「決定」: 実機（v0.2.82）で、決定を押すと `Cannot read properties of null (reading 'key')` で止まり、元画像のままだった
const up = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('../lib/api', () => ({ uploadFile: up.uploadFile, discardUpload: vi.fn(async () => {}) }));
vi.mock('../lib/imageCrop', async (orig) => {
  const m = await orig<typeof import('../lib/imageCrop')>();
  return {
    ...m,
    readImageInfo: vi.fn(async () => ({ width: 400, height: 300, alpha: false, animated: false })),
    prepareUpload: vi.fn(async (file: File) => file),
  };
});

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
URL.createObjectURL = vi.fn(() => 'blob:test');
URL.revokeObjectURL = vi.fn();

let instance: ReturnType<typeof mount> | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  host?.remove();
  instance = undefined;
  host = undefined;
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('切り抜きのダイアログ', () => {
  it('決定を押すと、エラーなしで閉じ、その画像を切り抜きとして上げ直す', async () => {
    let n = 0;
    up.uploadFile.mockImplementation((file: File) => ({
      promise: Promise.resolve({ id: `a${++n}`, file_name: file.name, mime: 'image/png', size: 1, width: 400, height: 300, has_thumb: false }),
      abort: () => {},
    }));
    host = document.createElement('div');
    document.body.append(host);
    let c!: { addFiles: (f: File[]) => void };
    instance = mount(Composer, { target: host, props: { placeholder: '' } });
    c = instance as unknown as typeof c;
    await settle(); // マウント後の effect（接続先の識別で添付を捨てる）が済んでから入れる
    c.addFiles([new File([new Uint8Array(4)], 'p.png', { type: 'image/png' })]);
    flushSync();
    console.log('IMM', host.innerHTML.includes('composer-upload'), up.uploadFile.mock.calls.length);
    await settle();
    const thumb = host.querySelector<HTMLButtonElement>('.composer-upload-thumb');
    expect(thumb).not.toBeNull();
    thumb!.click();
    await settle();
    expect(document.querySelector('.image-crop-area')).not.toBeNull();
    const decide = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '決定');
    expect(decide).toBeTruthy();
    decide!.click(); // 例外が出ると vitest が失敗にする
    await settle();
    expect(document.querySelector('.image-crop-area')).toBeNull();
    expect(up.uploadFile).toHaveBeenCalledTimes(2);
  });
});
