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
    remove: vi.fn(async () => {}),
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
    expect(deps.remove).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('できた添付を取り消すと、本文の埋め込みを外し、添付を消す', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    store.cancel(store.items[0].key);
    expect(deps.unembed).toHaveBeenCalledWith('![[attachments/a.png]]');
    expect(deps.remove).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('送るとき、本文に残った添付は消さず、埋め込みを消したものは消す。一覧は空になる', async () => {
    const { store, deps, net } = setup();
    store.add([file('a.png'), file('b.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    net.handles[1].resolve(att('b.png'));
    await flush();
    store.settle('文 ![[attachments/a.png]]');
    expect(deps.remove).toHaveBeenCalledTimes(1);
    expect(deps.remove).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'b.png' }));
    expect(store.items).toHaveLength(0);
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
    expect(deps.remove).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
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
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('入力欄が無いとき（埋め込めない）は、新しい添付を入れずに消す', async () => {
    const { store, deps, net } = setup({ insert: vi.fn(() => false) });
    store.add([file('a.png')]);
    await flush();
    net.handles[0].resolve(att('a.png'));
    await flush();
    expect(store.items).toHaveLength(0);
    expect(deps.remove).toHaveBeenCalledWith(expect.objectContaining({ file_name: 'a.png' }));
  });

  it('画面を閉じるとき、途中のアップロードは中止する', async () => {
    const { store, net } = setup();
    store.add([file('a.png')]);
    await flush();
    store.dispose();
    expect(net.handles[0].abort).toHaveBeenCalled();
  });
});
