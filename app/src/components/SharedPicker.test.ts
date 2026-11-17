// @vitest-environment jsdom
// プラグインの「共有フォルダから選ぶ」画面: 一覧・フォルダ・単一／複数／フォルダだけ・取り消し
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../lib/transport/shared', () => ({ sharedApi: { list: mocks.list } }));

import SharedPicker from './SharedPicker.svelte';
import { pickSharedFiles } from '../lib/plugins/sharedPicker';

const e = (path: string, kind: 'file' | 'dir' = 'file'): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: 1,
  modified: 1,
  mime: null,
  message_id: null,
  file_id: null,
});

const tree: Record<string, SharedEntry[]> = {
  '': [e('docs', 'dir'), e('a.txt')],
  docs: [e('docs/b.txt')],
};

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  mocks.list.mockReset();
  mocks.list.mockImplementation(async (p: string) => tree[p] ?? []);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  document.body.innerHTML = '';
});

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    flushSync();
  }
};
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.shared-picker-row')].map((b) => b.textContent?.trim());
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

describe('SharedPicker（共有フォルダから選ぶ）', () => {
  it('一覧を出す（フォルダが先）', async () => {
    const ondone = vi.fn();
    app = mount(SharedPicker, { target: document.body, props: { ondone } });
    await flush();
    expect(rows()).toEqual(['docs/', 'a.txt']);
  });

  it('単一: ファイルを押すと、その 1 件で ondone', async () => {
    const ondone = vi.fn();
    app = mount(SharedPicker, { target: document.body, props: { ondone } });
    await flush();
    button('a.txt').click();
    flushSync();
    expect(ondone).toHaveBeenCalledWith([expect.objectContaining({ path: 'a.txt' })]);
  });

  it('フォルダを開いて、中のファイルを選べる。上へで戻る', async () => {
    app = mount(SharedPicker, { target: document.body, props: { ondone: vi.fn() } });
    await flush();
    button('docs/').click();
    await flush();
    expect(mocks.list).toHaveBeenLastCalledWith('docs');
    expect(rows()).toEqual(['b.txt']);
    button('上へ').click();
    await flush();
    expect(rows()).toEqual(['docs/', 'a.txt']);
  });

  it('取り消すと null', async () => {
    const ondone = vi.fn();
    app = mount(SharedPicker, { target: document.body, props: { ondone } });
    await flush();
    button('取り消す').click();
    expect(ondone).toHaveBeenCalledWith(null);
  });

  it('複数: 押すと選び、確定で全部の件。0 件のときは確定できない', async () => {
    const ondone = vi.fn();
    app = mount(SharedPicker, { target: document.body, props: { multiple: true, ondone } });
    await flush();
    expect(button('選ぶ（0）').disabled).toBe(true);
    button('a.txt').click();
    flushSync();
    button('docs/').click();
    await flush();
    button('b.txt').click();
    flushSync();
    button('上へ').click();
    await flush();
    button('選ぶ（2）').click();
    expect(ondone.mock.calls[0][0].map((x: SharedEntry) => x.path)).toEqual(['a.txt', 'docs/b.txt']);
  });

  it('フォルダだけ: ファイルは並ばず、フォルダに「選ぶ」を押して確定できる', async () => {
    const ondone = vi.fn();
    app = mount(SharedPicker, { target: document.body, props: { folderOnly: true, ondone } });
    await flush();
    expect(rows()).toEqual(['docs/']);
    expect(button('選ぶ（0）').disabled).toBe(true);
    button('選ぶ').click();
    flushSync();
    expect(ondone).not.toHaveBeenCalled();
    button('選ぶ（1）').click();
    expect(ondone).toHaveBeenCalledWith([expect.objectContaining({ path: 'docs', kind: 'dir' })]);
  });

  it('読めなければエラーを出す（固定の文ではなく、理由の文）', async () => {
    mocks.list.mockRejectedValueOnce(new Error('サーバーに届きません'));
    app = mount(SharedPicker, { target: document.body, props: { ondone: vi.fn() } });
    await flush();
    expect(document.querySelector('[role=alert]')?.textContent).toContain('サーバーに届きません');
  });
});

describe('pickSharedFiles（口）', () => {
  it('画面を開いて、選んだ結果を返す。終わったら画面は外す', async () => {
    const p = pickSharedFiles({});
    await flush();
    button('a.txt').click();
    await expect(p).resolves.toEqual([expect.objectContaining({ path: 'a.txt' })]);
    expect(document.querySelector('[role=dialog]')).toBeNull();
  });
});
