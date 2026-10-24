import { describe, expect, it, vi } from 'vitest';
import { ComposerAttachments, type AttachDeps } from './composerAttachments.svelte';
import type { Attachment } from './protocol/Attachment';

// 入力欄の添付: 上げる・埋め込む・取り消す・送る・切り抜きのやり直し（通信と入力欄は差し替える）
const att = (name: string): Attachment => ({
  id: `id-${name}`,
  file_name: name,
  mime: 'image/png',
  size: 1,
  width: null,
  height: null,
  has_thumb: false,
  deleted: false,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 通信の 1 回（完了・失敗は手で決める） */
function fakeUploads() {
  const handles: { resolve: (a: Attachment) => void; reject: (e: Error) => void; abort: ReturnType<typeof vi.fn> }[] = [];
  const upload = vi.fn(() => {
    const abort = vi.fn();
    let resolve!: (a: Attachment) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<Attachment>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    handles.push({ resolve, reject, abort });
    return { promise, abort };
  });
  return { upload, handles };
}

function setup(over: Partial<AttachDeps> = {}) {
  const net = fakeUploads();
  const deps: AttachDeps = {
    prepare: async (file) => file,
    upload: net.upload,
    discard: vi.fn(async () => {}),
    mark: vi.fn(),
    insert: vi.fn(() => true),
    replace: vi.fn(() => true),
    unembed: vi.fn(),
    readInfo: async () => null,
    preview: () => null,
    revoke: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
  return { store: new ComposerAttachments(deps), deps, net };
}

const file = (name: string) => new File(['x'], name, { type: 'image/png' });

describe('入力欄の添付', () => {
  it('選んだら上げ、できたら本文に埋め込む（名前は返ってきたもの）', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    expect(store.uploading).toBe(true);
    net.handles[0].resolve(att('a (2).png'));
    await flush();
    expect(deps.insert).toHaveBeenCalledWith('![[attachments/a (2).png]]');
    expect(store.uploading).toBe(false);
    expect(store.items[0]).toMatchObject({ status: 'ready', embed: '![[attachments/a (2).png]]' });
  });

  it('失敗したら理由を出し、再試行で上げ直す', async () => {
    const { store, net } = setup();
    store.add([file('a.png')]);
    await flush();
    net.handles[0].reject(new Error('容量が足りません'));
    await flush();
    expect(store.items[0]).toMatchObject({ status: 'failed', error: '容量が足りません' });
    expect(store.uploading).toBe(false);
    store.retry(store.items[0].key);
    await flush();
    expect(store.items[0].status).toBe('uploading');
    net.handles[1].resolve(att('a.png'));
    await flush();
    expect(store.items[0].status).toBe('ready');
  });

  it('アップロード中に取り消すと中止し、あとでできたものは入れずに消す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    const key = store.items[0].key;
    store.cancel(key);
    expect(net.handles[0].abort).toHaveBeenCalled();
    expect(store.items).toHaveLength(0);
    net.handles[0].resolve(att('a.png'));
    await flush();
    expect(deps.insert).not.toHaveBeenCalled();
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('できた添付を取り消すと、本文の埋め込みを外し、添付を消す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    store.cancel(store.items[0].key);
    expect(deps.unembed).toHaveBeenCalledWith('![[attachments/a.png]]');
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('送るとき、本文に残った添付は一覧から外すだけ（消さない）。残っていないものは一覧に残す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png'), file('b.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    net.handles[1].resolve(att('b.png'));
    await flush();
    store.settle('文 ![[attachments/a.png]]');
    expect(deps.discard).not.toHaveBeenCalled();
    expect(store.items.map((s) => s.file.name)).toEqual(['b.png']);
  });

  it('切り抜きは、送れたあとなら上げ直して埋め込みを入れ替え、前のものは消す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    const key = store.items[0].key;
    store.recrop(key, { x: 0, y: 0, w: 1, h: 1 } as never);
    await flush();
    expect(store.items[0].status).toBe('uploading');
    net.handles[1].resolve(att('a (2).png'));
    await flush();
    expect(deps.replace).toHaveBeenCalledWith('![[attachments/a.png]]', '![[attachments/a (2).png]]');
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
    expect(store.items[0]).toMatchObject({ status: 'ready', embed: '![[attachments/a (2).png]]' });
  });

  it('切り抜きのやり直しが失敗しても、前のもの（本文の埋め込み）は残す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    store.recrop(store.items[0].key, null);
    await flush();
    net.handles[1].reject(new Error('通信できません'));
    await flush();
    expect(store.items[0]).toMatchObject({ status: 'ready', embed: '![[attachments/a.png]]' });
    expect(deps.toast).toHaveBeenCalled();
    expect(deps.discard).not.toHaveBeenCalled();
  });

  it('入力欄が無いとき（埋め込めない）は、新しい添付を入れずに消す', async () => {
    const { store, deps, net } = setup({ insert: vi.fn(() => false) });
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    expect(store.items).toHaveLength(0);
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('上げた添付は投稿前の印を付け、取り消したら外す。送ったものは印を残す（投稿の反映まで）', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png'), file('b.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    net.handles[1].resolve(att('b.png'));
    await flush();
    expect(deps.mark).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }), true);
    store.settle('![[attachments/a.png]]');
    expect(deps.mark).not.toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }), false);
    store.cancel(store.items[0].key);
    expect(deps.mark).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'b.png' }), false);
  });

  it('画面を閉じるとき、途中のアップロードは中止する', async () => {
    const { store, net } = setup();
    store.add([file('a.png')]);
    await flush();
    store.dispose();
    expect(net.handles[0].abort).toHaveBeenCalled();
  });

  it('本文から埋め込みを消したら、すぐ取り消す（投稿前だけ消せる。一覧からも外す）', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png'), file('b.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    net.handles[1].resolve(att('b.png'));
    await flush();
    // 利用者が a の埋め込みだけ消した（b は残っている）
    store.sync('![[attachments/b.png]]');
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
    expect(deps.discard).not.toHaveBeenCalledWith(expect.objectContaining({ file_name: 'b.png' }));
    expect(store.items.map((s) => s.file.name)).toEqual(['b.png']);
  });

  it('埋め込みを消しても、アップロード中のものは対象外（終わったら入る）', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    store.sync('');
    expect(deps.discard).not.toHaveBeenCalled();
    net.handles[0].resolve(att('a.png'));
    await flush();
    expect(deps.insert).toHaveBeenCalled();
  });

  it('切り抜きの入れ替えの途中で、入力欄の更新（sync）が来ても、その添付は取り消されない', async () => {
    const { store, deps, net } = setup({
      replace: vi.fn((from: string, to: string) => {
        // 入れ替えの最中に、入力欄が更新されたのと同じ（新しい埋め込みが入った本文）
        store.sync(`![[${to.slice(2, -2)}]]`);
        return true;
      }),
    });
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    store.recrop(store.items[0].key, null);
    await flush();
    net.handles[1].resolve(att('a (2).png'));
    await flush();
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ status: 'ready', embed: '![[attachments/a (2).png]]' });
    expect(deps.discard).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('接続先・利用者が変わったら一覧を捨てる（取り消しの通信は中止し、終わったものは入れない・消さない）', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png'), file('b.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    store.forget();
    expect(store.items).toHaveLength(0);
    expect(net.handles[1].abort).toHaveBeenCalled();
    net.handles[1].resolve(att('b.png'));
    await flush();
    expect(deps.insert).toHaveBeenCalledTimes(1);
    expect(deps.discard).not.toHaveBeenCalled();
  });
});
