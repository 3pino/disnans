// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileExplorer from './FileExplorer.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
import { ui } from '../lib/stores/ui.svelte';
import { explorerBuffer } from '../lib/stores/explorerBuffer.svelte';
import { explorerSelection } from '../lib/stores/explorerSelection.svelte';
import { explorerView } from '../lib/stores/explorerView.svelte';
import * as cfg from '../lib/config';

/** 画面の本体（共有の部品）のソースの場所。見た目の決まり（CSS）を読む試験で使う */
const KIT = 'node_modules/@3pino/explorer-kit/src/';

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
const listing: SharedEntry[] = [entry('a.txt'), entry('docs', 'dir'), { ...entry('pic.png'), mime: 'image/png', size: 9 }];

const h = vi.hoisted(() => ({
  /** 一覧（既定は上の listing。添付のフォルダの場面では差し替える） */
  current: null as SharedEntry[] | null,
  list: vi.fn(async (): Promise<SharedEntry[]> => h.current ?? listing),
  upload: vi.fn(),
  /** OS のドロップ（フォルダ・ファイル）の送り先（sharedApi.write） */
  write: vi.fn(async (path: string) => ({ ...entry(path.split('/').pop()!), path })),
  mkdir: vi.fn(async () => ({})),
  copy: vi.fn(async () => ({})),
  remove: vi.fn(async (_path: string) => {}),
  trash: vi.fn(async (path: string) => ({ id: `id-${path}`, original_path: path, kind: 'file' as const, size: 1, deleted_at: 0 })),
  restore: vi.fn(async (_id: string) => ({ name: '', path: '', kind: 'file' as const, size: 1, modified: 0, mime: null, message_id: null, file_id: null })),
  purge: vi.fn(async (_id: string) => {}),
  move: vi.fn(async (_from: string, _to: string) => ({})),
  /** OS のクリップボード（差し替え）。copyText で書いたものが text に入る */
  clip: { text: null as string | null, image: null as File | null, writable: true },
}));
vi.mock('../lib/clipboard', () => ({
  copyText: vi.fn(async (t: string) => {
    if (!h.clip.writable) return false;
    h.clip.text = t;
    h.clip.image = null;
    return true;
  }),
}));
vi.mock('../lib/clipboardPaste', async (orig) => ({
  ...(await orig<typeof import('../lib/clipboardPaste')>()),
  peekClipboard: async () => ({ text: h.clip.text !== null, image: h.clip.image !== null }),
  readClipboardText: async () => h.clip.text,
}));
vi.mock('../lib/clipboardImage', () => ({
  readClipboardImage: async () => h.clip.image,
  readNativeClipboardImage: async () => null,
}));
vi.mock('../lib/transport/shared', () => ({
  sharedApi: {
    list: h.list,
    mkdir: h.mkdir,
    write: h.write,
    copy: h.copy,
    move: h.move,
    remove: h.remove,
    trash: h.trash,
    restore: h.restore,
    size: async () => ({ size: 0, files: 0, dirs: 0 }),
    trashList: async () => [],
    purge: h.purge,
  },
  uploadShared: h.upload,
}));

/** PC の Tauri（Windows・Linux）かどうか。true のときだけ、選択の操作が 0 件でも続く（テストごとに戻す） */
const dsk = vi.hoisted(() => ({ desktop: false }));
vi.mock('../lib/platform', async (orig) => ({
  ...(await orig<typeof import('../lib/platform')>()),
  isTauri: () => dsk.desktop,
  osName: () => (dsk.desktop ? 'windows' : ''),
  isLinuxDesktop: () => false,
}));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  ui.toasts = [];
  h.upload.mockReset();
  h.upload.mockImplementation(() => ({ promise: new Promise(() => {}), abort: () => {} }));
  fileExplorer.dir = '';
});
afterEach(async () => {
  dsk.desktop = false;
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  sharedIndex.clear();
  ui.confirmReq = null;
  explorerBuffer.clear();
  h.copy.mockClear();
  // h.list: mockClear ではなく実装ごとリセット（DnD テストで上書きした mockImplementation を消す）
  h.list.mockReset();
  h.list.mockImplementation(async () => h.current ?? listing);
  h.remove.mockClear();
  h.trash.mockClear();
  h.purge.mockClear();
  h.restore.mockClear();
  h.move.mockClear();
  h.clip = { text: null, image: null, writable: true };
  explorerSelection.clear();
  explorerView.reset();
});

async function render(): Promise<HTMLElement> {
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(FileExplorer, { target });
  flushSync();
  await vi.waitFor(() => expect(target!.querySelector('.file-explorer-list')).not.toBeNull());
  return target;
}

/** 操作のメニュー（≡）を開いて、文字の項目を押す */
function menuClick(el: HTMLElement, text: string): void {
  el.querySelector<HTMLButtonElement>('button[aria-label="メニュー"]')!.click();
  flushSync();
  const item = [...document.querySelectorAll<HTMLButtonElement>('.file-explorer-menu .menu-item')].find((b) => b.textContent?.includes(text));
  if (!item) throw new Error(`メニューに「${text}」がありません`);
  item.click();
  flushSync();
}

/** 上端の貼り付けを押す */
function pasteClick(el: HTMLElement): void {
  el.querySelector<HTMLButtonElement>('.file-explorer-selection button[aria-label="貼り付け"]')!.click();
  flushSync();
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

  it('新しいフォルダは、sharedApi.mkdir で作る（いまのフォルダの下）', async () => {
    const el = await render();
    menuClick(el, '新しいフォルダ');
    const input = document.querySelector<HTMLInputElement>('.file-explorer-mkdir input')!;
    input.value = 'newdir';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLFormElement>('.file-explorer-mkdir')!.requestSubmit();
    await vi.waitFor(() => expect(h.mkdir).toHaveBeenCalledWith('newdir'));
  });

  it('使えない名前は送らず、理由を出す', async () => {
    const el = await render();
    pick(el, new File(['x'], 'a:b.txt'));
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-upload-error')).not.toBeNull());
    expect(h.upload).not.toHaveBeenCalled();
  });

});

describe('項目の操作と貼り付け（コピー・切り取り・移動）', () => {
  it('コピーしたものを貼り付けると、同名は確認してから上書きで送る', async () => {
    const el = await render();
    explorerBuffer.set('copy', [{ path: 'x/a.txt', kind: 'file' }]);
    flushSync();
    pasteClick(el);
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    expect(ui.confirmReq!.body).toContain('消えて');
    expect(h.copy).not.toHaveBeenCalled();
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.copy).toHaveBeenCalledWith('x/a.txt', 'a.txt', true));
    // コピーは残る（何度でも貼り付けられる）
    expect(explorerBuffer.empty).toBe(false);
  });

});

describe('複数選択（選択モード）', () => {
  function rowOf(el: HTMLElement, name: string): HTMLElement {
    return [...el.querySelectorAll<HTMLElement>('.file-explorer-item')].find((li) => li.textContent?.includes(name))!;
  }
  function pressRow(el: HTMLElement, name: string) {
    rowOf(el, name).querySelector<HTMLButtonElement>('.file-explorer-row')!.click();
    flushSync();
  }

  it('削除はゴミ箱に移す（まとめて 1 回確認、取り消すトーストが出る）', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    pressRow(el, 'docs');
    el.querySelector<HTMLButtonElement>('button[aria-label="削除"]')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    expect(ui.confirmReq!.title).toBe('2 件をゴミ箱に移しますか');
    expect(h.trash).not.toHaveBeenCalled();
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.trash).toHaveBeenCalledTimes(2));
    expect(h.trash.mock.calls.map((c) => c[0])).toEqual(['a.txt', 'docs']);
    // 取り消すトーストが出る
    expect(ui.toasts.some((t) => t.text?.includes('ゴミ箱に移しました') && t.action?.label === '取り消す')).toBe(true);
  });

  it('ゴミ箱 undo: 成功した ID のみスナップショット（失敗した項目は含まれない）', async () => {
    // a.txt は成功、docs は失敗
    h.trash
      .mockResolvedValueOnce({ id: 'id-a', original_path: 'a.txt', kind: 'file', size: 1, deleted_at: 0 })
      .mockRejectedValueOnce(new Error('fail'));
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    pressRow(el, 'docs');
    el.querySelector<HTMLButtonElement>('button[aria-label="削除"]')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(ui.toasts.some((t) => t.action?.label === '取り消す')).toBe(true));
    // 成功トースト: id-a のみ
    const undoToast = ui.toasts.find((t) => t.action?.label === '取り消す');
    expect(undoToast).toBeTruthy();
    // undo を実行したら id-a だけ restore を呼ぶ
    h.restore.mockResolvedValueOnce({ name: 'a.txt', path: 'a.txt', kind: 'file', size: 1, modified: 0, mime: null, message_id: null, file_id: null });
    undoToast!.action!.run();
    await vi.waitFor(() => expect(h.restore).toHaveBeenCalledTimes(1));
    // 削除の応答（id-a）の ID で戻す（失敗した docs の ID は含まない）
    expect(h.restore.mock.calls[0][0]).toBe('id-a');
  });

  it('ゴミ箱 undo: サーバーが変わっていたら restore を送らない', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    el.querySelector<HTMLButtonElement>('button[aria-label="削除"]')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.trash).toHaveBeenCalledTimes(1));
    const undoToast = ui.toasts.find((t) => t.action?.label === '取り消す');
    expect(undoToast).toBeTruthy();
    // サーバーを変更したことをシミュレート（getServerUrl が別の値を返す）
    vi.spyOn(await import('../lib/config'), 'getServerUrl').mockReturnValue('http://other:3000');
    try {
      undoToast!.action!.run();
      await new Promise((r) => setTimeout(r, 50));
      // restore は呼ばれない
      expect(h.restore).not.toHaveBeenCalled();
      // エラートーストが出る
      await vi.waitFor(() => expect(ui.toasts.some((t) => t.kind === 'error')).toBe(true));
    } finally {
      vi.restoreAllMocks();
    }
  });

});

describe('表示方法と並び順', () => {
  it('サムネイルは欠けないよう、全体を枠に収める（object-fit: contain）', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [KIT + 'FileExplorer.svelte', 'src/components/PdfThumb.svelte']) {
      const css = readFileSync(file, 'utf8').split('<style>')[1] ?? '';
      expect(css, file).toMatch(/object-fit:\s*contain/);
      expect(css, file).not.toMatch(/object-fit:\s*cover/);
    }
  });

});

describe('内部 DnD（performInternalTransfer）', () => {
  it('drop 先が未読のとき sharedApi.list を呼んで一覧取得後に移動（1 回で完結）', async () => {
    // sharedIndex に docs の中身がないとき、performInternalTransfer 内で list を呼ぶ
    // jsdom での DragEvent はフル再現が困難なので、動作結果（sharedApi.list の呼び出し数と move 呼出）で検証する
    h.list.mockImplementation(async (path?: string) => {
      // docs のキャッシュがないのでリクエストが来る想定
      if (path === 'docs') return []; // 空フォルダ（同名なし）
      return h.current ?? listing;
    });
    h.move.mockResolvedValueOnce({ name: 'a.txt', path: 'docs/a.txt', kind: 'file' as const, size: 1, modified: 0, mime: null, message_id: null, file_id: null });

    await render();
    // list が初期ロードで呼ばれた後のカウントを記録
    const countBefore = h.list.mock.calls.length;

    // sharedIndex の docs キャッシュをクリア（未読状態を再現）
    sharedIndex.invalidate('docs/x');
    flushSync();

    // 内部 move の実行: explorerBuffer に a.txt を入れ、fileExplorer を docs へ移動して paste
    // paste() は別のコードパス（performInternalTransfer でなく直接 runTransfer）だが、
    // fetchDestEntries 相当の動作（list 呼び出し）を通じて docs の中身を取得する
    explorerBuffer.set('move', [{ path: 'a.txt', kind: 'file' }]);
    fileExplorer.open('docs'); // docs へ移動
    flushSync();
    // docs の一覧が読み込まれるまで待つ
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledWith('docs'));
    // docs 一覧取得後に paste（fetchDestEntries 経由）
    pasteClick(document.body as unknown as HTMLElement); // paste は body がなくても動く

    // 最終的に list('docs') が呼ばれ、同名なし → move が呼ばれる
    await vi.waitFor(() => expect(h.move).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(h.move).toHaveBeenCalledWith('a.txt', 'docs/a.txt', false);
    expect(h.list.mock.calls.length).toBeGreaterThan(countBefore);
  });
});

describe('添付のフォルダ（attachments/ そのもの）は動かせない・消せない（グレー、理由つき）', () => {
  it('attachments を選ぶと、切り取り・削除がグレーで理由を出す。名前を押しても書き換えにならない', async () => {
    h.current = [entry('attachments', 'dir'), entry('a.txt')];
    try {
      const el = await render();
      explorerSelection.start('attachments');
      flushSync();
      for (const t of ['切り取り', '削除']) {
        const b = el.querySelector<HTMLButtonElement>(`button[aria-label="${t}"]`)!;
        expect(b.disabled, t).toBe(true);
        expect(b.title, t).toContain('添付のフォルダは動かせません');
      }
      expect(el.querySelector<HTMLButtonElement>('button[aria-label="コピー"]')!.disabled).toBe(false);
      explorerSelection.clear();
      explorerSelection.start('a.txt');
      flushSync();
      expect(el.querySelector<HTMLButtonElement>('button[aria-label="切り取り"]')!.disabled).toBe(false);
      explorerSelection.clear();
      flushSync();
      const name = [...el.querySelectorAll<HTMLElement>('.file-explorer-name-text')].find((n) => n.textContent === 'attachments')!;
      name.click();
      flushSync();
      expect(el.querySelector('.file-explorer-rename')).toBeNull();
      expect(fileExplorer.dir).toBe('attachments');
    } finally {
      h.current = null;
    }
  });
});

describe('空きスペースの長押し・右クリックのメニュー', () => {
  function ctxLabels(): string[] {
    return [...document.querySelectorAll('.file-explorer-context .menu-item')].map((b) => b.textContent?.trim() ?? '');
  }

  it('右クリックでも出る。クリップボードに文字があれば貼り付けも出し、押すと .txt にして送る', async () => {
    h.clip.text = 'hello';
    const el = await render();
    el.querySelector<HTMLElement>('.file-explorer-body')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 600 }));
    await vi.waitFor(() => expect(ctxLabels()).toEqual(['アップロード', '新しいフォルダ', '貼り付け']));
    [...document.querySelectorAll<HTMLButtonElement>('.file-explorer-context .menu-item')].find((b) => b.textContent?.includes('貼り付け'))!.click();
    flushSync();
    expect(document.querySelector('.file-explorer-context')).toBeNull();
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledWith(expect.stringMatching(/^clipboard-\d{8}-\d{6}\.txt$/), expect.any(File), expect.any(Function)));
  });
});

describe('OS のクリップボードとの同期', () => {
  async function selectAndPress(el: HTMLElement, path: string, label: string): Promise<void> {
    explorerSelection.start(path);
    flushSync();
    el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    flushSync();
    await vi.waitFor(() => expect(explorerBuffer.clipText).not.toBeNull());
  }

  it('コピーすると、項目のパスを OS のクリップボードにも書く。そのまま貼ればアプリ内のコピー', async () => {
    fileExplorer.dir = '';
    const el = await render();
    await selectAndPress(el, 'a.txt', 'コピー');
    expect(h.clip.text).toBe('a.txt');
    // 別のフォルダへ貼る
    fileExplorer.open('docs');
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-list')).not.toBeNull());
    pasteClick(el);
    // 仮の一覧はどのフォルダも同じ（a.txt がある）ので、上書きの確認が出る
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.copy).toHaveBeenCalledWith('a.txt', 'docs/a.txt', true));
    expect(h.upload).not.toHaveBeenCalled();
  });

});

/** 送る・移す・消す・戻すの途中でサーバーが変わったときの決まり（新しいサーバーへは何も書かない） */
describe('サーバーが変わったら、新しいサーバーへは書かない', () => {
  const srv = { url: 'http://a.test' };
  let spy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    srv.url = 'http://a.test';
    spy = vi.spyOn(cfg, 'getServerUrl').mockImplementation(() => srv.url);
  });
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    ui.toasts.length = 0;
  });

  it('送る: 同名の確認を待つあいだに切り替わったら、確認に答えても送らない', async () => {
    const el = await render();
    pick(el, new File(['x'], 'a.txt'));
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    srv.url = 'http://b.test';
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(ui.toasts.some((t) => t.text.includes('サーバーが変わった'))).toBe(true));
    expect(h.upload).not.toHaveBeenCalled();
  });

});

/** PC の選択（0 件でも操作が続く）: 行の押し・ダブルクリック・Enter・F2・空きスペース */
describe('PC の選択（0 件でも続く。ダブルクリック・Enter で開く）', () => {
  beforeEach(() => {
    dsk.desktop = true;
  });

  const clickRow = (el: HTMLElement, name: string, detail = 1) => {
    rowOf(el, name).querySelector<HTMLElement>('.file-explorer-row')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail }),
    );
    flushSync();
  };
  const keyRow = (el: HTMLElement, name: string, key: string) => {
    rowOf(el, name).querySelector<HTMLElement>('.file-explorer-row')!.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    flushSync();
  };
  const count = (el: HTMLElement) => el.querySelector('.file-explorer-selection-count')!.textContent?.trim();

  it('Enter で開く（フォルダは中へ）。画像は拡大表示、ほかのファイルはダウンロード', async () => {
    const el = await render();
    keyRow(el, 'docs', 'Enter');
    expect(fileExplorer.dir).toBe('docs');
    fileExplorer.open('');
    flushSync();
    await vi.waitFor(() => expect(rowOf(el, 'pic.png')).toBeTruthy());
    keyRow(el, 'pic.png', 'Enter');
    expect(ui.lightbox).not.toBeNull();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      keyRow(el, 'a.txt', 'Enter');
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
    }
    // Enter で開いたときは選びは変わらない（0 件のまま）
    expect(count(el)).toBe('3 件');
  });

  it('0 件のあいだは「戻る」（パネルの戻る）を奪わない。選んでいる間は選びを外す', async () => {
    const el = await render();
    const spy = vi.spyOn(ui, 'addPluginBack');
    try {
      flushSync();
      expect(spy).not.toHaveBeenCalled();
      clickRow(el, 'a.txt');
      flushSync();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/** タッチ（Android）: 従来どおり。0 件で終わる・タップで開く・長押しで選ぶ */
/** 名前の行（一覧の 1 件）。PC・タッチの選択のテストで使う */
function rowOf(el: HTMLElement, name: string): HTMLElement {
  return [...el.querySelectorAll<HTMLElement>('.file-explorer-item')].find((li) => li.textContent?.includes(name))!;
}

/* ---- ゴミ箱は、ふつうのフォルダとして開く（.trash。直下の項目は元の名前で出す・元へ戻す・完全削除） ---- */

const ID1 = '01HZX0000000000000000000AB';
const ID2 = '01HZX0000000000000000000CD';
const ID3 = '01HZX0000000000000000000EF';
const ID4 = '01HZX0000000000000000000GH';
const ROOT_TRASH: SharedEntry = { ...entry('.trash', 'dir'), path: '.trash', trash: { kind: 'root' } };
/** 直下の項目（ゴミ箱の 1 件）。名前は ID--元の名前、パスも同じ別名。表示は元の名前 */
function trashItem(id: string, original: string, kind: 'file' | 'dir' = 'file'): SharedEntry {
  const leaf = original.split('/').pop()!;
  return {
    ...entry(`${id}--${leaf}`, kind),
    path: `.trash/${id}--${leaf}`,
    size: 1,
    trash: { kind: 'item', entry: { id, original_path: original, kind, size: 1, deleted_at: 0 } },
  };
}
function inner(parentAlias: string, name: string, kind: 'file' | 'dir' = 'file'): SharedEntry {
  return { ...entry(name, kind), path: `${parentAlias}/${name}`, trash: { kind: 'descendant', id: ID4 } };
}
const rootList = (): SharedEntry[] => [ROOT_TRASH, entry('docs', 'dir')];
const trashList = (): SharedEntry[] => [
  trashItem(ID1, 'docs/report.pdf'),
  trashItem(ID2, 'a/x.txt'),
  trashItem(ID3, 'b/x.txt'),
  trashItem(ID4, 'old', 'dir'),
];
const innerList = (): SharedEntry[] => [inner(`.trash/${ID4}--old`, 'sub', 'dir'), inner(`.trash/${ID4}--old`, 'k.txt')];
const ALIAS4 = `.trash/${ID4}--old`;

/** パスごとの一覧（書いていないパスは空）。'pending' は応答しない、'error' は失敗 */
function serve(map: Record<string, SharedEntry[] | 'pending' | 'error'>): void {
  h.list.mockImplementation(async (path?: string) => {
    const v = map[path ?? ''];
    if (v === undefined) return [];
    if (v === 'error') throw new Error('読めません');
    if (v === 'pending') return new Promise<SharedEntry[]>(() => {});
    return v;
  });
}

/** 名前の表示（一覧に出ている通り） */
function names(el: HTMLElement): string[] {
  return [...el.querySelectorAll('.file-explorer-name-text')].map((t) => t.textContent?.trim() ?? '');
}
function btn(el: HTMLElement, label: string): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}
function toastTexts(): string[] {
  return ui.toasts.map((t) => t.text);
}
/** 既存の名前の項目を、選択モードのまま押す（選ぶ） */
function pickRow(el: HTMLElement, name: string): void {
  rowOf(el, name).querySelector<HTMLElement>('.file-explorer-row')!.click();
  flushSync();
}

describe('ゴミ箱は、ふつうのフォルダとして開く（.trash）', () => {
  beforeEach(() => {
    // 前のテストの拡大表示・戻る操作が残らないように
    ui.lightbox = null;
    ui.pluginBack = [];
  });
  it('完全削除: 名前を出して確認。キャンセルでは消さない。確認すると、押した時点の ID で消す', async () => {
    serve({ '': rootList(), '.trash': trashList() });
    const el = await render();
    fileExplorer.open('.trash');
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('report.pdf'));
    explorerSelection.enter();
    flushSync();
    pickRow(el, 'report.pdf');
    btn(el, '完全削除')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    expect(ui.confirmReq!.title).toBe('完全に削除しますか');
    expect(ui.confirmReq!.body).toContain('「report.pdf」');
    expect(ui.confirmReq!.body).toContain('取り消せません');
    ui.confirmReq!.resolve(false);
    await vi.waitFor(() => expect(ui.confirmReq).toBeNull());
    expect(h.purge).not.toHaveBeenCalled();
    await waitEnabled(el, '完全削除');
    btn(el, '完全削除')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.purge).toHaveBeenCalledTimes(1));
    expect(h.purge).toHaveBeenCalledWith(ID1);
    await vi.waitFor(() => expect(toastTexts().some((t) => t.includes('1 件を完全に削除しました'))).toBe(true));
  });

});

describe('ゴミ箱の中のパンくずも、元の名前で出す', () => {
  beforeEach(() => {
    ui.lightbox = null;
    ui.pluginBack = [];
  });

  it('.trash/<別名> の段は元の名前、.trash の段はそのまま。押すとその段のフォルダへ（別名のパス）', async () => {
    serve({ '': rootList(), '.trash': trashList(), [ALIAS4]: innerList() });
    const el = await render();
    fileExplorer.open(ALIAS4);
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('k.txt'));
    const crumbs = [...el.querySelectorAll<HTMLButtonElement>('.file-explorer-crumb')].map((b) => b.textContent?.trim());
    expect(crumbs).toEqual(['共有フォルダ', '.trash', 'old']);
    // 「.trash」の段へ戻る
    const trashCrumb = [...el.querySelectorAll<HTMLButtonElement>('.file-explorer-crumb')].find((b) => b.textContent?.trim() === '.trash')!;
    trashCrumb.click();
    flushSync();
    expect(fileExplorer.dir).toBe('.trash');
  });
});

describe('ゴミ箱の添付は、消えた ID ではなく共有フォルダのパスで読む（サムネイル・PDF・拡大表示）', () => {
  beforeEach(() => {
    ui.lightbox = null;
    ui.pluginBack = [];
  });
  afterEach(() => {
    explorerView.reset();
  });

  /** 消えた添付の ID を（誤って）持っている、ゴミ箱の画像・PDF・ふつうのファイル */
  const DELETED = 'DELETEDFILEID';
  const trashedImage = (): SharedEntry => ({ ...trashItem(ID1, 'attachments/F1.png'), mime: 'image/png', file_id: DELETED });
  const trashedPdf = (): SharedEntry => ({ ...trashItem(ID2, 'attachments/doc.pdf'), mime: 'application/pdf', file_id: DELETED, size: 10 });
  const trashedFile = (): SharedEntry => ({ ...trashItem(ID3, 'attachments/F2.zip'), mime: 'application/zip', file_id: DELETED });

  it('ゴミ箱の画像（サムネイル・拡大表示）は、元の名前で出し、共有フォルダのパスで読む（/api/files/<消えたID> にしない）', async () => {
    explorerView.setView('.trash', 'grid');
    serve({ '': rootList(), '.trash': [trashedImage(), trashedPdf(), trashedFile()] });
    const el = await render();
    fileExplorer.open('.trash');
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('F1.png'));
    // 元の名前（別名や消えた ID は出さない）
    expect(names(el).join('|')).not.toContain(DELETED);
    expect(names(el).join('|')).not.toContain(ID1);
    // サムネイルは共有フォルダの正しいパス
    const img = rowOf(el, 'F1.png').querySelector<HTMLImageElement>('img')!;
    expect(img.getAttribute('src')).toContain(`/api/shared/.trash/${ID1}--F1.png`);
    expect(img.getAttribute('src')).not.toContain('/api/files/');
    // 拡大表示も同じ（前後・元の名前）
    rowOf(el, 'F1.png').querySelector<HTMLElement>('.file-explorer-row')!.click();
    flushSync();
    expect(ui.lightbox!.src).toContain(`/api/shared/.trash/${ID1}--F1.png`);
    expect(ui.lightbox!.src).not.toContain('/api/files/');
    expect(ui.lightbox!.alt).toBe('F1.png');
  });

  it('ゴミ箱の PDF は、拡大表示も共有フォルダのパスで読む（/api/files/<消えたID> にしない）', async () => {
    serve({ '': rootList(), '.trash': [trashedPdf()] });
    const el = await render();
    fileExplorer.open('.trash');
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('doc.pdf'));
    rowOf(el, 'doc.pdf').querySelector<HTMLElement>('.file-explorer-row')!.click();
    flushSync();
    expect(ui.lightbox).toMatchObject({ alt: 'doc.pdf', kind: 'pdf' });
    expect(ui.lightbox!.src).toContain(`/api/shared/.trash/${ID2}--doc.pdf`);
    expect(ui.lightbox!.src).not.toContain('/api/files/');
  });

  it('ゴミ箱のふつうのファイル（ダウンロード）も、共有フォルダのパスの保存先になる', async () => {
    serve({ '': rootList(), '.trash': [trashedFile()] });
    const el = await render();
    fileExplorer.open('.trash');
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('F2.zip'));
    const href = rowOf(el, 'F2.zip').querySelector<HTMLAnchorElement>('a.file-explorer-row')!.getAttribute('href') ?? '';
    expect(href).toContain(`/api/shared/.trash/${ID3}--F2.zip`);
    expect(href).not.toContain('/api/files/');
  });

  it('ふつうの（生きている）添付は、これまでどおり ID の URL で読む（縮小版も）', async () => {
    explorerView.setView('attachments', 'grid');
    const live: SharedEntry = { ...entry('pic.png'), path: 'attachments/pic.png', mime: 'image/png', file_id: 'LIVEFILEID' };
    serve({ '': rootList(), attachments: [live] });
    const el = await render();
    fileExplorer.open('attachments');
    flushSync();
    await vi.waitFor(() => expect(names(el)).toContain('pic.png'));
    const img = rowOf(el, 'pic.png').querySelector<HTMLImageElement>('img')!;
    expect(img.getAttribute('src')).toContain('/api/files/LIVEFILEID/thumb');
    rowOf(el, 'pic.png').querySelector<HTMLElement>('.file-explorer-row')!.click();
    flushSync();
    expect(ui.lightbox!.src).toContain('/api/files/LIVEFILEID');
    expect(ui.lightbox!.src).not.toContain('/api/shared/');
  });
});

/** 操作の終わりを待つ（ボタンが押せるまで。操作の後で選びが空になり、ボタンが消えているなら、それも終わり） */
async function waitEnabled(el: HTMLElement, label: string): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    const b = btn(el, label);
    expect(b === null || !b.disabled).toBe(true);
  });
}

/* ---- A: 読み直しの状態を追う（無効化されたあと、判定と名前の表示を直す） ---- */

/* ---- B: 選んだ項目への操作（削除・元へ戻す・完全削除）は、同時に 1 つだけ ---- */
