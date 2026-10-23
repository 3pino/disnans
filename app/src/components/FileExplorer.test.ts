// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileExplorer from './FileExplorer.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
import { ui } from '../lib/stores/ui.svelte';

// 共有フォルダの一覧の書き込み（アップロード・同名の確認・フォルダ作成）の流れ。HTTP は差し替える
const entry = (name: string, kind: 'file' | 'dir' = 'file'): SharedEntry => ({
  name,
  path: name,
  kind,
  size: 1,
  modified: 0,
  mime: null,
  message_id: null,
  file_id: null,
});
const listing: SharedEntry[] = [entry('a.txt'), entry('docs', 'dir')];

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  mkdir: vi.fn(async () => ({})),
}));
vi.mock('../lib/transport/shared', () => ({
  sharedApi: {
    list: async () => listing,
    mkdir: h.mkdir,
    move: async () => ({}),
    remove: async () => {},
  },
  uploadShared: h.upload,
}));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  h.upload.mockReset();
  h.upload.mockImplementation(() => ({ promise: new Promise(() => {}), abort: () => {} }));
  fileExplorer.dir = '';
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  sharedIndex.clear();
  ui.confirmReq = null;
});

async function render(): Promise<HTMLElement> {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(FileExplorer, { target });
  flushSync();
  await vi.waitFor(() => expect(target!.querySelector('.file-explorer-list')).not.toBeNull());
  return target;
}

function pick(el: HTMLElement, file: File): void {
  const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('共有フォルダの書き込み', () => {
  it('同名のファイルは、確認してから上書きする（確認なしには送らない）', async () => {
    const el = await render();
    pick(el, new File(['x'], 'a.txt'));
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    expect(ui.confirmReq!.body).toContain('消えて');
    expect(h.upload).not.toHaveBeenCalled();
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledWith('a.txt', expect.any(File), expect.any(Function)));
  });

  it('確認で取り消せば、送らない', async () => {
    const el = await render();
    pick(el, new File(['x'], 'a.txt'));
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(false);
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-uploads')).toBeNull());
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('同名のない新しいファイルは、確認なしに送る', async () => {
    const el = await render();
    pick(el, new File(['x'], 'new.txt'));
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledWith('new.txt', expect.any(File), expect.any(Function)));
    expect(ui.confirmReq).toBeNull();
  });

  it('使えない名前は送らず、理由を出す', async () => {
    const el = await render();
    pick(el, new File(['x'], 'a:b.txt'));
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-upload-error')).not.toBeNull());
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('新しいフォルダは、名前を確かめてから作る', async () => {
    const el = await render();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('新しいフォルダ'))!;
    btn.click();
    flushSync();
    const input = document.querySelector<HTMLInputElement>('.file-explorer-mkdir input')!;
    input.value = 'x/y';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLFormElement>('.file-explorer-mkdir')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.file-explorer-mkdir-error')?.textContent).toContain('使えません'));
    expect(h.mkdir).not.toHaveBeenCalled();
  });
});
