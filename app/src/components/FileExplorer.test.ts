// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import FileExplorer from './FileExplorer.svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import { fileExplorer } from '../lib/stores/fileExplorer.svelte';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
import { ui } from '../lib/stores/ui.svelte';
import { adjacentItem } from '../lib/lightbox';
import { explorerBuffer } from '../lib/stores/explorerBuffer.svelte';
import { explorerSelection } from '../lib/stores/explorerSelection.svelte';
import { explorerView } from '../lib/stores/explorerView.svelte';
import { LONG_PRESS_MS } from '../lib/sortable';

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
  upload: vi.fn(),
  mkdir: vi.fn(async () => ({})),
  copy: vi.fn(async () => ({})),
  remove: vi.fn(async (_path: string) => {}),
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
    list: async () => h.current ?? listing,
    mkdir: h.mkdir,
    copy: h.copy,
    move: h.move,
    remove: h.remove,
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
  explorerBuffer.clear();
  h.copy.mockClear();
  h.remove.mockClear();
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

/** 操作のメニュー（≡）の項目の文字（開いて読み、閉じる） */
function menuLabels(el: HTMLElement): string[] {
  el.querySelector<HTMLButtonElement>('button[aria-label="メニュー"]')!.click();
  flushSync();
  const labels = [...document.querySelectorAll('.file-explorer-menu .menu-item')].map((b) => b.textContent?.trim() ?? '');
  document.querySelector<HTMLButtonElement>('.menu-backdrop')?.click();
  flushSync();
  return labels;
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
    menuClick(el, '新しいフォルダ');
    const input = document.querySelector<HTMLInputElement>('.file-explorer-mkdir input')!;
    input.value = 'x/y';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLFormElement>('.file-explorer-mkdir')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.file-explorer-mkdir-error')?.textContent).toContain('使えません'));
    expect(h.mkdir).not.toHaveBeenCalled();
  });

  it('上端は共通の見出し（PanelBar = .top-bar）の 1 行。操作は同じ行にある', async () => {
    const el = await render();
    expect(el.querySelectorAll('header')).toHaveLength(1);
    const bar = el.querySelector('.panel-bar');
    expect(bar?.classList.contains('top-bar')).toBe(true);
    expect(bar?.querySelector('button[aria-label="メニュー"]')).not.toBeNull();
    expect(bar?.querySelector('.file-explorer-selection')).not.toBeNull();
    expect(bar?.querySelector('.file-explorer-crumbs')).toBeNull();
    // パンくずは、上端の直後の行（バーの下）
    expect(bar?.nextElementSibling?.classList.contains('file-explorer-crumbs')).toBe(true);
  });
});

describe('上端のバーの件数・操作（選んでいなくても同じバーを出す）', () => {
  it('選んでいないときは、件数（フォルダの項目数）を出し、コピー・切り取り・削除は押せない', async () => {
    const el = await render();
    expect(el.querySelector('.file-explorer-selection-count')?.textContent).toBe('3 件');
    for (const label of ['コピー', '切り取り', '削除']) {
      expect(el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.disabled, label).toBe(true);
    }
  });

  it('選ぶと「N 件選択中」になり、操作が押せる。空きスペースで解除すると件数に戻る', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    expect(el.querySelector('.file-explorer-selection-count')?.textContent).toBe('0 件選択中');
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="コピー"]')?.disabled).toBe(true);
    const row = [...el.querySelectorAll<HTMLElement>('.file-explorer-item')].find((li) => li.textContent?.includes('a.txt'))!;
    row.querySelector<HTMLButtonElement>('.file-explorer-row')!.click();
    flushSync();
    expect(el.querySelector('.file-explorer-selection-count')?.textContent).toBe('1 件選択中');
    expect(el.querySelector<HTMLButtonElement>('button[aria-label="コピー"]')?.disabled).toBe(false);
  });

  it('「選択をやめる」と「移動」は無い（切り取り＋貼り付けで足りる）', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    expect(el.textContent).not.toContain('選択をやめる');
    expect(el.querySelector('button[aria-label="移動"]')).toBeNull();
    expect(el.querySelector('button[aria-label="閉じる"]')).toBeNull();
  });

  it('空きスペースを押すと選択を解除する。項目・パンくず・バーは解除しない', async () => {
    const el = await render();
    explorerSelection.enter();
    explorerSelection.toggle('a.txt');
    flushSync();
    el.querySelector<HTMLElement>('.file-explorer-selection-count')!.click();
    el.querySelector<HTMLElement>('.file-explorer-crumbs')!.click();
    el.querySelector<HTMLElement>('.file-explorer-item')!.click();
    flushSync();
    expect(explorerSelection.active).toBe(true);
    el.querySelector<HTMLElement>('.file-explorer-body')!.click();
    flushSync();
    expect(explorerSelection.active).toBe(false);
    expect(explorerSelection.count).toBe(0);
  });

  it('切り取りでは、できたことの通知を出さない（貼り付けが押せるようになる）', async () => {
    const el = await render();
    explorerSelection.enter();
    explorerSelection.toggle('a.txt');
    flushSync();
    el.querySelector<HTMLButtonElement>('button[aria-label="切り取り"]')!.click();
    flushSync();
    expect(explorerBuffer.mode).toBe('move');
    expect(ui.toasts.some((t) => t.text.includes('切り取りました'))).toBe(false);
  });
});

describe('項目の操作と貼り付け（コピー・切り取り・移動）', () => {
  function itemMenuLabels(el: HTMLElement, name: string): string[] {
    el.querySelector<HTMLButtonElement>(`button[aria-label="${name} の操作"]`)!.click();
    flushSync();
    return [...document.querySelectorAll('.shared-entry-menu-item')].map((b) => b.textContent?.trim() ?? '');
  }

  it('「…」はプロパティだけ（フォルダもファイルも）', async () => {
    const el = await render();
    expect(itemMenuLabels(el, 'docs')).toEqual(['プロパティ']);
    // 開いたメニューを閉じる（外側を押す）
    document.querySelector<HTMLButtonElement>('.menu-backdrop')?.click();
    flushSync();
    expect(itemMenuLabels(el, 'a.txt')).toEqual(['プロパティ']);
  });

  it('貼り付けは選択のバーの中、削除の左。何も無ければ押せない（≡ には出さない）', async () => {
    const el = await render();
    const labels = [...el.querySelectorAll('.file-explorer-selection-actions button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['コピー', '切り取り', '貼り付け', '削除']);
    const btn = el.querySelector<HTMLButtonElement>('.file-explorer-selection button[aria-label="貼り付け"]')!;
    expect(btn.disabled).toBe(true);
    explorerBuffer.set('copy', [{ path: 'x/b.txt', kind: 'file' }]);
    flushSync();
    expect(btn.disabled).toBe(false);
    expect(menuLabels(el)).not.toContain('貼り付け');
    expect(menuLabels(el)).not.toContain('アップロード');
  });

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

  it('切り取りの貼り付けで、上書きを取り消したものは、送らずバッファに残す（もう一度貼り付けられる）', async () => {
    const el = await render();
    explorerBuffer.set('move', [{ path: 'x/a.txt', kind: 'file' }]);
    flushSync();
    pasteClick(el);
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(false);
    await vi.waitFor(() => expect(ui.confirmReq).toBeNull());
    expect(h.copy).not.toHaveBeenCalled();
    expect(explorerBuffer.items.map((i) => i.path)).toEqual(['x/a.txt']);
  });

  it('切り取りの途中の項目は薄く出す（貼り付けるまで残る）', async () => {
    const el = await render();
    explorerBuffer.set('move', [{ path: 'a.txt', kind: 'file' }]);
    flushSync();
    expect(el.querySelector('.file-explorer-item-cut')?.textContent).toContain('a.txt');
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

  it('≡ に「選択モード」と「一覧」は無い', async () => {
    const el = await render();
    const labels = menuLabels(el);
    expect(labels.some((l) => l.includes('選択モード'))).toBe(false);
    expect(labels.some((l) => l.startsWith('一覧'))).toBe(false);
    expect(labels.some((l) => l.startsWith('詳細'))).toBe(true);
  });

  it('選択モードでは、行を押すと選び直す（開かない）。件数を出す', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    pressRow(el, 'docs');
    expect(el.querySelector('.file-explorer-selection-count')?.textContent).toContain('2 件選択中');
    expect(fileExplorer.dir).toBe('');
    expect(rowOf(el, 'docs').querySelector('.file-explorer-row')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('長押しで選択モードに入り、その項目を選ぶ（押したあとのクリックでは開かない）', async () => {
    vi.useFakeTimers();
    try {
      const el = await render();
      const row = rowOf(el, 'docs');
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 20);
      flushSync();
      expect(explorerSelection.active).toBe(true);
      expect(explorerSelection.has('docs')).toBe(true);
      // 離したあとのクリックは、フォルダを開かない
      row.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      rowOf(el, 'docs').querySelector<HTMLButtonElement>('.file-explorer-row')!.click();
      flushSync();
      expect(fileExplorer.dir).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('コピーは、フォルダを除いてバッファに入れ、選択を終える', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    pressRow(el, 'docs');
    [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="コピー"]')][0].click();
    flushSync();
    expect(explorerBuffer.mode).toBe('copy');
    expect(explorerBuffer.items).toEqual([{ path: 'a.txt', kind: 'file' }]);
    expect(explorerSelection.active).toBe(false);
  });

  it('選択中の「戻る」（Alt+← など）は、選択モードを終える。フォルダは戻らない', async () => {
    fileExplorer.dir = 'docs';
    await render();
    const before = ui.pluginBack.length;
    explorerSelection.start('docs/x');
    flushSync();
    expect(ui.pluginBack).toHaveLength(before + 1);
    expect(ui.back()).toBe(true);
    flushSync();
    expect(explorerSelection.active).toBe(false);
    expect(fileExplorer.dir).toBe('docs');
    // 選択していなければ、戻る操作には何も足さない
    expect(ui.pluginBack).toHaveLength(before);
  });

  it('削除は、件数をまとめて 1 回だけ確認してから、順に消す', async () => {
    const el = await render();
    explorerSelection.enter();
    flushSync();
    pressRow(el, 'a.txt');
    pressRow(el, 'docs');
    el.querySelector<HTMLButtonElement>('button[aria-label="削除"]')!.click();
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    expect(ui.confirmReq!.title).toBe('2 件を削除しますか');
    expect(h.remove).not.toHaveBeenCalled();
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledTimes(2));
    expect(h.remove.mock.calls.map((c) => c[0])).toEqual(['a.txt', 'docs']);
  });
});

describe('表示方法と並び順', () => {
  it('アイコン（グリッド）は、画像だけ小さい画像を出す（フォルダ・ほかは絵のアイコン）', async () => {
    explorerView.setView('', 'grid');
    const el = await render();
    expect(el.querySelector('.file-explorer-view-grid')).not.toBeNull();
    const imgs = [...el.querySelectorAll<HTMLImageElement>('.file-explorer-thumb img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toContain('/pic.png');
    expect(el.querySelector('.file-explorer-thumb svg')).not.toBeNull();
  });

  it('アイコン表示では、PDF はサムネイルの部品（1 ページ目）を出す。大きすぎる PDF とほかのファイルは絵のアイコン', async () => {
    h.current = [
      { ...entry('doc.pdf'), mime: 'application/pdf' },
      { ...entry('huge.pdf'), mime: 'application/pdf', size: 200 * 1024 * 1024 },
      entry('a.txt'),
    ];
    explorerView.setView('', 'grid');
    try {
      const el = await render();
      const item = (n: string) => [...el.querySelectorAll('.file-explorer-item')].find((li) => li.textContent?.includes(n))!;
      expect(item('doc.pdf').querySelector('.pdf-thumb')).not.toBeNull();
      expect(item('huge.pdf').querySelector('.pdf-thumb')).toBeNull();
      expect(item('a.txt').querySelector('.pdf-thumb')).toBeNull();
    } finally {
      h.current = null;
    }
  });

  it('PDF を押すと、全画面のプレビュー（kind: pdf）で開く。画像は画像のまま', async () => {
    h.current = [{ ...entry('doc.pdf'), mime: 'application/pdf' }, { ...entry('pic.png'), mime: 'image/png' }];
    try {
      const el = await render();
      const row = (n: string) => [...el.querySelectorAll('.file-explorer-item')].find((li) => li.textContent?.includes(n))!.querySelector<HTMLElement>('.file-explorer-row')!;
      expect(row('doc.pdf').tagName).toBe('BUTTON');
      row('doc.pdf').querySelector<HTMLElement>('.file-explorer-icon')!.click();
      expect(ui.lightbox).toMatchObject({ alt: 'doc.pdf', kind: 'pdf' });
      expect(ui.lightbox!.src).toContain('/doc.pdf');
      ui.lightbox = null;
      row('pic.png').querySelector<HTMLElement>('.file-explorer-icon')!.click();
      expect(ui.lightbox).toMatchObject({ alt: 'pic.png', kind: 'image' });
    } finally {
      h.current = null;
      ui.lightbox = null;
    }
  });

  it('アイコン表示の枠に地の色は付けない。選んだ項目の「…」に色を付けるのは詳細だけ', async () => {
    const { readFileSync } = await import('node:fs');
    const css = (readFileSync('src/components/FileExplorer.svelte', 'utf8').split('<style>')[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const thumb = css.match(/\.file-explorer-thumb \{[^}]*\}/)![0];
    expect(thumb).not.toMatch(/background/);
    const dots = css.match(/[^{}]*shared-entry-menu-button\)[^{}]*\{[^}]*\}/g) ?? [];
    expect(dots.length).toBeGreaterThan(0);
    for (const rule of dots) expect(rule).toMatch(/file-explorer-view-details/);
  });

  it('サムネイルは欠けないよう、全体を枠に収める（object-fit: contain）', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['FileExplorer.svelte', 'PdfThumb.svelte']) {
      const css = readFileSync(`src/components/${file}`, 'utf8').split('<style>')[1] ?? '';
      expect(css, file).toMatch(/object-fit:\s*contain/);
      expect(css, file).not.toMatch(/object-fit:\s*cover/);
    }
  });

  it('詳細は列の見出しを出し、種類・サイズ・更新日時を各項目に出す', async () => {
    const el = await render();
    const heads = [...el.querySelectorAll('.file-explorer-columns span:not(.file-explorer-col-actions)')].map((x) => x.textContent);
    expect(heads).toEqual(['名前', '種類', 'サイズ', '更新日時']);
    const pic = [...el.querySelectorAll('.file-explorer-item')].find((li) => li.textContent?.includes('pic.png'))!;
    expect(pic.querySelector('.file-explorer-col-kind')?.textContent).toBe('画像');
    expect(pic.querySelector('.file-explorer-col-size')?.textContent).toBe('9 B');
  });

  it('並び順を変えると、フォルダを先に、名前の降順で並ぶ', async () => {
    explorerView.setSort('', 'name', 'desc');
    const el = await render();
    const names = [...el.querySelectorAll('.file-explorer-item .file-explorer-name')].map((x) => x.textContent);
    expect(names).toEqual(['docs', 'pic.png', 'a.txt']);
  });

  it('操作のメニューの「表示」で選ぶと、開いているフォルダだけその表示になる', async () => {
    fileExplorer.dir = 'docs';
    const el = await render();
    menuClick(el, 'アイコン');
    expect(explorerView.of('docs').view).toBe('grid');
    expect(explorerView.of('').view).toBe('details');
    expect(el.querySelector('.file-explorer-view-grid')).not.toBeNull();
  });

  it('既定は詳細。「…」は詳細でも各行に出す', async () => {
    const el = await render();
    expect(el.querySelector('.file-explorer-view-details')).not.toBeNull();
    expect(el.querySelectorAll('.file-explorer-view-details .shared-entry-actions')).toHaveLength(3);
  });
});

describe('操作メニューは外側の幕より前にある（押せない不具合の再発防止）', () => {
  // jsdom は、コンポーネントの（スコープの）CSS を当てないので、ここでは書き方を見る。
  // 実際の押し方（タッチ）の検査は app/scripts/touch-check.mjs（ブラウザが要る・vitest の外）
  it('メニューの見た目に z-index を書かない（design-system の .menu が幕（-1）より前に出る）', async () => {
    const { readFileSync } = await import('node:fs');
    // テストは app/ で動く（npm test）
    for (const file of ['FileExplorer.svelte', 'SharedEntryActions.svelte']) {
      const css = (readFileSync(`src/components/${file}`, 'utf8').split('<style>')[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
      const menuRules = css.match(/[^{}]*(file-explorer-popup-menu|shared-entry-menu)[^{}]*\{[^}]*\}/g) ?? [];
      expect(menuRules.length, file).toBeGreaterThan(0);
      for (const rule of menuRules) expect(rule, file).not.toMatch(/z-index/);
    }
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

describe('名前の変更（名前を押すと、その場で入力欄になる）', () => {
  function nameOf(el: HTMLElement, name: string): HTMLElement {
    return [...el.querySelectorAll<HTMLElement>('.file-explorer-name-text')].find((n) => n.textContent === name)!;
  }
  function type(input: HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('名前を押すと入力欄に置き換わり（全画面のダイアログは出さない）、Enter で変える', async () => {
    const el = await render();
    nameOf(el, 'docs').click();
    flushSync();
    expect(fileExplorer.dir).toBe('');
    expect(document.querySelector('.modal')).toBeNull();
    const input = el.querySelector<HTMLTextAreaElement>('.file-explorer-item textarea.file-explorer-rename')!;
    expect(input.value).toBe('docs');
    type(input, 'papers');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(h.move).toHaveBeenCalledWith('docs', 'papers'));
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-rename')).toBeNull());
  });

  it('名前の書き換えでは、注意の文を出さない（共有フォルダでも attachments の中でも）', async () => {
    h.current = [{ ...entry('a.png'), path: 'attachments/a.png' }, entry('b.txt')];
    try {
      const el = await render();
      nameOf(el, 'a.png').click();
      flushSync();
      expect(el.querySelector('.file-explorer-rename')).not.toBeNull();
      expect(el.querySelector('.file-explorer-rename-note')).toBeNull();
      el.querySelector<HTMLTextAreaElement>('.file-explorer-rename')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      flushSync();
      nameOf(el, 'b.txt').click();
      flushSync();
      expect(el.querySelector('.file-explorer-rename')).not.toBeNull();
      expect(el.textContent).not.toContain('リンクは切れます');
      expect(el.querySelector('.file-explorer-rename-note')).toBeNull();
    } finally {
      h.current = null;
    }
  });

  it('Esc で取り消す（変えない）。使えない名前は理由を出して入力欄のまま', async () => {
    const el = await render();
    nameOf(el, 'a.txt').click();
    flushSync();
    let input = el.querySelector<HTMLTextAreaElement>('.file-explorer-rename')!;
    type(input, 'b:c.txt');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(el.querySelector('.file-explorer-rename-error')?.textContent).toContain('使えません');
    expect(h.move).not.toHaveBeenCalled();
    input = el.querySelector<HTMLTextAreaElement>('.file-explorer-rename')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(el.querySelector('.file-explorer-rename')).toBeNull();
    expect(h.move).not.toHaveBeenCalled();
  });

  it('名前の外（行のほか）を押すと、普通に開く。選択モードでは名前を押しても選び直すだけ', async () => {
    const el = await render();
    const row = [...el.querySelectorAll<HTMLElement>('.file-explorer-item')].find((li) => li.textContent?.includes('docs'))!;
    explorerSelection.enter();
    flushSync();
    nameOf(el, 'docs').click();
    flushSync();
    expect(explorerSelection.has('docs')).toBe(true);
    expect(el.querySelector('.file-explorer-rename')).toBeNull();
    explorerSelection.clear();
    flushSync();
    row.querySelector<HTMLElement>('.file-explorer-icon')!.click();
    flushSync();
    expect(fileExplorer.dir).toBe('docs');
  });
});

describe('選択の印', () => {
  it('選んでいない印は灰色（印の色を付けない）、選んだ印だけ水色', async () => {
    const el = await render();
    explorerSelection.start('a.txt');
    flushSync();
    const checks = [...el.querySelectorAll('.file-explorer-check')];
    expect(checks).toHaveLength(3);
    expect(checks.filter((c) => c.classList.contains('file-explorer-check-on'))).toHaveLength(1);
  });
});

describe('空きスペースの長押し・右クリックのメニュー', () => {
  function ctxLabels(): string[] {
    return [...document.querySelectorAll('.file-explorer-context .menu-item')].map((b) => b.textContent?.trim() ?? '');
  }

  it('長押しでアップロードのメニューが出る。何も無ければ貼り付けは出さない', async () => {
    vi.useFakeTimers();
    try {
      const el = await render();
      const body = el.querySelector<HTMLElement>('.file-explorer-body')!;
      body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 600 }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 20);
      flushSync();
      expect(ctxLabels()).toEqual(['アップロード']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('項目の上の長押しでは出さない（項目の選択になる）', async () => {
    vi.useFakeTimers();
    try {
      const el = await render();
      el.querySelector<HTMLElement>('.file-explorer-item')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 20);
      flushSync();
      expect(document.querySelector('.file-explorer-context')).toBeNull();
      expect(explorerSelection.active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('右クリックでも出る。クリップボードに文字があれば貼り付けも出し、押すと .txt にして送る', async () => {
    h.clip.text = 'hello';
    const el = await render();
    el.querySelector<HTMLElement>('.file-explorer-body')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 600 }));
    await vi.waitFor(() => expect(ctxLabels()).toEqual(['アップロード', '貼り付け']));
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

  it('コピーのあとに、ほかで文字をコピーし直していれば、その文字を貼る（バッファは貼らない）', async () => {
    const el = await render();
    await selectAndPress(el, 'a.txt', 'コピー');
    h.clip.text = 'other';
    pasteClick(el);
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalled());
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('ほかで画像をコピーし直していれば、画像を送る', async () => {
    const el = await render();
    await selectAndPress(el, 'a.txt', 'コピー');
    h.clip.text = null;
    h.clip.image = new File(['x'], 'clipboard-1.png', { type: 'image/png' });
    pasteClick(el);
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledWith('clipboard-1.png', expect.any(File), expect.any(Function)));
    expect(h.copy).not.toHaveBeenCalled();
  });

  it('クリップボードに書けなかったときは、バッファを貼る（クリップボードの古い中身は貼らない）', async () => {
    h.clip.text = 'old';
    h.clip.writable = false;
    const el = await render();
    explorerSelection.start('a.txt');
    flushSync();
    el.querySelector<HTMLButtonElement>('button[aria-label="コピー"]')!.click();
    flushSync();
    await Promise.resolve();
    fileExplorer.open('docs');
    await vi.waitFor(() => expect(el.querySelector('.file-explorer-list')).not.toBeNull());
    pasteClick(el);
    // 仮の一覧はどのフォルダも同じ（a.txt がある）ので、上書きの確認が出る
    await vi.waitFor(() => expect(ui.confirmReq).not.toBeNull());
    ui.confirmReq!.resolve(true);
    await vi.waitFor(() => expect(h.copy).toHaveBeenCalledWith('a.txt', 'docs/a.txt', true));
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('Ctrl+V（入力欄の外）で、OS のファイルを送る。入力欄の中の貼り付けは邪魔しない', async () => {
    await render();
    const file = new File(['x'], 'from-os.pdf');
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { files: [file], getData: () => '' } });
    document.body.dispatchEvent(ev);
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledWith('from-os.pdf', file, expect.any(Function)));
    expect(ev.defaultPrevented).toBe(true);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    const ev2 = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev2, 'clipboardData', { value: { files: [file], getData: () => '' } });
    input.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    input.remove();
  });
});

describe('写真の拡大（前後は、このフォルダの画像を今の並び順で）', () => {
  it('画像を開くと、前後は画像だけ（並び順どおり）。ファイル・PDF は含めない。←→で移る', async () => {
    const img = (name: string): SharedEntry => ({ ...entry(name), mime: 'image/png' });
    h.current = [img('b.png'), entry('note.txt'), img('a.png'), { ...entry('doc.pdf'), mime: 'application/pdf' }, img('c.png')];
    try {
      const el = await render();
      const row = [...el.querySelectorAll<HTMLElement>('.file-explorer-item')].find((li) => li.textContent?.includes('b.png'))!;
      row.querySelector<HTMLButtonElement>('.file-explorer-row')!.click();
      flushSync();
      expect(ui.lightbox?.alt).toBe('b.png');
      const gallery = ui.lightboxGallery!();
      expect(gallery.map((i) => i.alt)).toEqual(['a.png', 'b.png', 'c.png']);
      // 前後の決まり（←→の動きは Lightbox.test.ts）
      expect(adjacentItem(gallery, ui.lightbox!.src, -1)?.alt).toBe('a.png');
    } finally {
      h.current = null;
      ui.lightbox = null;
      ui.lightboxGallery = null;
    }
  });
});
