// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileProperties from './FileProperties.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';

const { mockSize } = vi.hoisted(() => ({
  mockSize: vi.fn(async () => ({ size: 12345, files: 3, dirs: 1 })),
}));

vi.mock('../lib/transport/shared', () => ({
  sharedApi: {
    size: mockSize,
    trash: vi.fn(),
    restore: vi.fn(),
    trashList: vi.fn(async () => []),
    purge: vi.fn(),
  },
}));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
});

const base: SharedEntry = { name: 'a.txt', path: 'docs/a.txt', kind: 'file', size: 2048, modified: 1_700_000_000_000, mime: 'text/plain', message_id: null, file_id: null };

function open(entry: SharedEntry): string {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(FileProperties, { target, props: { entry, onclose: () => {} } });
  flushSync();
  return document.body.textContent ?? '';
}

describe('プロパティ（読むだけ）', () => {
  it('名前・パス・種類（MIME）・サイズ・更新日時を出す。作成日時は出さない（サーバーが持たない）', () => {
    const text = open(base);
    expect(text).toContain('docs/a.txt');
    expect(text).toContain('TXT');
    expect(text).toContain('text/plain');
    expect(text).toContain('2.0 KB');
    expect(text).not.toContain('作成日時');
  });

  it('フォルダは計算中になり、サイズ取得後は件数を出す', async () => {
    open({ ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null, modified: 0 });
    // 最初は計算中
    expect(document.body.textContent).toContain('計算中');
    // size が返ったあとはバイト数と件数を出す
    await vi.waitFor(() => expect(document.body.textContent).toContain('12,345'));
    expect(document.body.textContent).toContain('3 ファイル');
  });

  it('添付の ID・投稿されたメッセージは出さない', () => {
    const text = open({ ...base, path: 'attachments/a.txt', file_id: 'F1', message_id: 'M1' });
    expect(text).not.toContain('F1');
    expect(text).not.toContain('M1');
    expect(text).not.toContain('添付の ID');
  });

  it('名前・パスを押すとコピーする（サイズ・更新日時は押せない）', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open(base);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.file-properties-copy')];
    expect(buttons.map((b) => b.textContent)).toEqual(['a.txt', 'docs/a.txt']);
    buttons[1].click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('docs/a.txt'));
  });

  it('見出し（名前・パスなど）は選べない', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/components/FileProperties.svelte', 'utf8');
    expect(src).toMatch(/\.file-properties dt \{[^}]*user-select: none/);
  });

  it('「メッセージを検索」で、ファイルの名前で検索を始める（フォルダには出さない）', async () => {
    const { ui } = await import('../lib/stores/ui.svelte');
    const { messageSearch } = await import('../lib/stores/search.svelte');
    const onclose = vi.fn();
    target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(FileProperties, { target, props: { entry: base, onclose } });
    flushSync();
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('メッセージを検索'))!;
    btn.click();
    expect(onclose).toHaveBeenCalled();
    expect(ui.searchOpen).toBe(true);
    expect(messageSearch.query).toBe('a.txt');
    messageSearch.setQuery('');
    ui.searchOpen = false;
  });

  it('フォルダには「メッセージを検索」を出さない', () => {
    const text = open({ ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null });
    expect(text).not.toContain('メッセージを検索');
  });
});

describe('フォルダサイズのstaleガード', () => {
  afterEach(() => { mockSize.mockReset(); });

  it('A→B→A の完了順逆転で最初の A のレスポンスを無視し、最後の A のレスポンスを表示する', async () => {
    // サイズ API の呼び出し順: A1(pending)→B(resolved immediately)→A2(pending)
    // 完了順: B → A1(stale) → A2(accepted)
    let resolveA1!: (v: { size: number; files: number; dirs: number }) => void;
    let resolveA2!: (v: { size: number; files: number; dirs: number }) => void;

    mockSize
      .mockImplementationOnce(() => new Promise((r) => { resolveA1 = r; }))
      .mockResolvedValueOnce({ size: 999, files: 1, dirs: 0 })
      .mockImplementationOnce(() => new Promise((r) => { resolveA2 = r; }));

    const dirA: SharedEntry = { ...base, name: 'docs', path: 'docs', kind: 'dir', size: 0, mime: null, modified: 0 };
    const dirB: SharedEntry = { ...base, name: 'sub', path: 'sub', kind: 'dir', size: 0, mime: null, modified: 0 };

    // A を開く → size 1回目 pending
    target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(FileProperties, { target, props: { entry: dirA, onclose: () => {} } });
    flushSync();
    expect(document.body.textContent).toContain('計算中');

    // B に切り替え（コンポーネントを入れ替えて A1 を stale にする）
    await unmount(instance);
    instance = mount(FileProperties, { target, props: { entry: dirB, onclose: () => {} } });
    flushSync();
    // B のレスポンスが届く
    await vi.waitFor(() => expect(document.body.textContent).toContain('999'));

    // A に戻る（A2 pending）
    await unmount(instance);
    instance = mount(FileProperties, { target, props: { entry: dirA, onclose: () => {} } });
    flushSync();

    // A1 のレスポンスを今届ける（stale: コンポーネントが unmount されたので sizeGen が進んでいる）
    resolveA1({ size: 1111, files: 5, dirs: 2 });
    await Promise.resolve();
    // 1111 は出ない（stale）、計算中のはず
    expect(document.body.textContent).not.toContain('1111');

    // A2 のレスポンス（採用）
    resolveA2({ size: 2222, files: 7, dirs: 3 });
    // 7 ファイルというテキストが出るのを待つ（2222 は toLocaleString で '2,222' になる）
    await vi.waitFor(() => expect(document.body.textContent).toContain('7 ファイル'));
    expect(document.body.textContent).not.toContain('1111');
    expect(document.body.textContent).not.toContain('5 ファイル'); // A1 の stale 結果が出ていない
  });
});