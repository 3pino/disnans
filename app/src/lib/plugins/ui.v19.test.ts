// @vitest-environment jsdom
// API 19 の disnans.ui の口: 口が無い環境では unsupported、あれば本体へ渡す（値の確かめも）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHARED_DRAG_TYPE } from '../sharedDrag';
import { createUi, type UiDeps } from './ui';
import { releaseAll } from './ui/mount';

const base = (over: Partial<UiDeps> = {}) => createUi({ toast: vi.fn(), confirm: vi.fn(async () => true), ...over });
const handle = () => ({ setBadge: vi.fn(), close: vi.fn() });
afterEach(() => releaseAll());

describe('ui（API 19）: 口が無い環境', () => {
  it('どれも unsupported（呼ぶ側が、使えないと分かる）', async () => {
    const ui = base();
    expect(() => ui.navItem({ id: 'a', label: 'A', icon: 'x', onOpen: () => {} })).toThrow(expect.objectContaining({ code: 'unsupported' }) as never);
    expect(() => ui.openLightbox({ src: '/a.png', alt: '' })).toThrow();
    expect(() => ui.renderPdfThumb(document.createElement('div'), '/a.pdf')).toThrow();
    expect(() => ui.openSearch()).toThrow();
    await expect(ui.clipboard.copyText('x')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(ui.saveBlob(new Blob(['a']), 'a.txt')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(ui.pickSharedFiles()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(ui.osDrop.listen(() => {})).rejects.toMatchObject({ code: 'unsupported' });
    expect(() => ui.osDrop.rootsOf(null)).toThrow(expect.objectContaining({ code: 'unsupported' }) as never);
  });

  it('dragType は本体の探す型と同じ（後方互換）', () => {
    expect(base().dragType).toBe(SHARED_DRAG_TYPE);
  });
});

describe('ui.navItem', () => {
  it('値を確かめ、本体の口へ渡す（view のときは onOpen が無くてもよい。ハンドルを返す）', () => {
    const navItem = vi.fn(() => handle());
    const ui = base({ navItem });
    const h = ui.navItem({ id: 'files', label: 'ファイル', icon: 'folder', view: 'files-view', badge: 2 });
    expect(navItem).toHaveBeenCalledWith({ id: 'files', label: 'ファイル', icon: 'folder', view: 'files-view', onOpen: undefined, badge: 2 });
    expect(typeof h.setBadge).toBe('function');
    expect(typeof h.close).toBe('function');
  });

  it('view も onOpen も無いのは invalid_argument。id・label・icon の空も同じ', () => {
    const ui = base({ navItem: vi.fn(() => handle()) });
    expect(() => ui.navItem({ id: 'a', label: 'A', icon: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => ui.navItem({ id: '', label: 'A', icon: 'x', onOpen: () => {} })).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => ui.navItem({ id: 'a', label: '', icon: 'x', onOpen: () => {} })).toThrow();
    expect(() => ui.navItem({ id: 'a', label: 'A', icon: 'x', onOpen: 1 as never })).toThrow();
  });
});

describe('ui.openLightbox', () => {
  it('平らな項目と一覧を本体へ渡す。src が無ければ invalid_argument', () => {
    const openLightbox = vi.fn();
    const ui = base({ openLightbox });
    const gallery = () => [{ src: '/a.png', alt: 'a' }];
    ui.openLightbox({ src: '/b.png', alt: 'b' }, gallery);
    expect(openLightbox).toHaveBeenCalledWith({ src: '/b.png', alt: 'b' }, gallery);
    expect(() => ui.openLightbox({ src: '', alt: '' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => ui.openLightbox({ src: '/x', alt: '' }, 'no' as never)).toThrow();
  });
});

describe('ui.renderPdfThumb', () => {
  it('要素・URL を確かめ、本体の口へ渡す（key は省くと URL）', () => {
    const renderPdfThumb = vi.fn(() => () => {});
    const ui = base({ renderPdfThumb });
    const el = document.createElement('div');
    ui.renderPdfThumb(el, '/a.pdf');
    expect(renderPdfThumb).toHaveBeenCalledWith(el, '/a.pdf', '/a.pdf');
    ui.renderPdfThumb(el, '/a.pdf', { key: 'k1' });
    expect(renderPdfThumb).toHaveBeenLastCalledWith(el, '/a.pdf', 'k1');
    expect(() => ui.renderPdfThumb('x' as never, '/a.pdf')).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => ui.renderPdfThumb(el, '')).toThrow();
  });
});

describe('ui.toast（操作つき）', () => {
  it('action（label と run）を本体へ渡す。run は呼ぶと実行される', () => {
    const toast = vi.fn();
    const ui = createUi({ toast, confirm: vi.fn(async () => true) });
    const run = vi.fn();
    ui.toast('削除しました', 'info', { label: '元に戻す', run });
    expect(toast).toHaveBeenCalledWith('削除しました', 'info', { label: '元に戻す', run: expect.any(Function) });
    toast.mock.calls[0][2].run();
    expect(run).toHaveBeenCalledOnce();
  });

  it('操作の形が正しくなければ invalid_argument（トーストは出さない）', () => {
    const toast = vi.fn();
    const ui = createUi({ toast, confirm: vi.fn(async () => true) });
    expect(() => ui.toast('x', 'info', { label: 'a' } as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => ui.toast('x', 'info', { label: '', run: () => {} })).toThrow();
    expect(toast).not.toHaveBeenCalled();
  });

  it('操作のないものは、今までどおり', () => {
    const toast = vi.fn();
    const ui = createUi({ toast, confirm: vi.fn(async () => true) });
    ui.toast('ふつう');
    expect(toast).toHaveBeenCalledWith('ふつう', 'info');
  });
});

describe('ui.openSearch / clipboard / saveBlob', () => {
  it('検索: 文字の語だけ受ける', () => {
    const openSearch = vi.fn();
    const ui = base({ openSearch });
    ui.openSearch('報告');
    expect(openSearch).toHaveBeenLastCalledWith('報告');
    expect(() => ui.openSearch(3 as never)).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
  });

  it('クリップボードは本体の 3 つの口へ渡す', async () => {
    const clipboard = {
      copyText: vi.fn(async () => true),
      readText: vi.fn(async () => 'x'),
      readImage: vi.fn(async () => null),
      peek: vi.fn(async () => ({ text: true, image: false }) as const),
      textName: vi.fn(() => 'clipboard-1.txt'),
    };
    const ui = base({ clipboard });
    expect(await ui.clipboard.copyText('hi')).toBe(true);
    expect(clipboard.copyText).toHaveBeenCalledWith('hi');
    expect(await ui.clipboard.readText()).toBe('x');
    expect(await ui.clipboard.readImage()).toBeNull();
    expect(await ui.clipboard.peek()).toEqual({ text: true, image: false });
    expect(ui.clipboard.textName()).toBe('clipboard-1.txt');
  });

  it('ダウンロード: url と name を確かめ、本体の口へ渡す（口が無ければ unsupported）', async () => {
    const download = vi.fn(async () => {});
    const ui = base({ download });
    await ui.download({ url: 'https://srv/api/shared/a.txt', name: 'a.txt' });
    expect(download).toHaveBeenCalledWith({ url: 'https://srv/api/shared/a.txt', name: 'a.txt' });
    await expect(ui.download({ url: '', name: 'a' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(base().download({ url: '/a', name: 'a' })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('押しの差し替え: MouseEvent と url・name を確かめ、本体へ渡す', () => {
    const interceptDownload = vi.fn(() => true);
    const ui = base({ interceptDownload });
    const ev = new MouseEvent('click');
    expect(ui.interceptDownload(ev, { url: '/a', name: 'a' })).toBe(true);
    expect(interceptDownload).toHaveBeenCalledWith(ev, { url: '/a', name: 'a' });
    expect(() => ui.interceptDownload('x' as never, { url: '/a', name: 'a' })).toThrow(expect.objectContaining({ code: 'invalid_argument' }) as never);
    expect(() => base().interceptDownload(ev, { url: '/a', name: 'a' })).toThrow(expect.objectContaining({ code: 'unsupported' }) as never);
  });

  it('保存: Blob と名前を確かめ、本体へ渡す', async () => {
    const saveBlob = vi.fn(async () => {});
    const ui = base({ saveBlob });
    const b = new Blob(['a']);
    await ui.saveBlob(b, 'a.txt');
    expect(saveBlob).toHaveBeenCalledWith(b, 'a.txt');
    await expect(ui.saveBlob('x' as never, 'a')).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(ui.saveBlob(b, '')).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('ui.pickSharedFiles / osDrop（本体の口へ渡す）', () => {
  it('pickSharedFiles: 選ぶ条件を渡す（既定は false）', async () => {
    const pickSharedFiles = vi.fn(async () => null);
    const ui = base({ pickSharedFiles });
    await ui.pickSharedFiles({ multiple: true });
    expect(pickSharedFiles).toHaveBeenCalledWith({ multiple: true, folderOnly: undefined });
  });

  it('osDrop は、渡された口をそのまま使える（形は explorer-kit と同じ）', async () => {
    const port = {
      listenNative: vi.fn(async () => () => {}),
      listen: vi.fn(async () => () => {}),
      entries: vi.fn(async () => ({ entries: [], skipped: [] })),
      release: vi.fn(async () => {}),
      rootsOf: vi.fn(() => []),
      entriesFromRoots: vi.fn(async () => []),
    };
    const ui = base({ osDrop: port });
    await ui.osDrop.listen(() => {});
    expect(port.listen).toHaveBeenCalledOnce();
    expect(await ui.osDrop.entries(3)).toEqual({ entries: [], skipped: [] });
  });
});
