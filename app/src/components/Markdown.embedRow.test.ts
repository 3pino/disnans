// @vitest-environment jsdom
// 本文の画像の埋め込みの横一列（実際の Markdown・FileLink・InlineNodes を描画する）。
// 見た目（高さ・横のはみ出し・なぞりの扱い）は app/scripts/feedback-ui-check.mjs（Chromium）で確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { SharedEntry } from '../lib/protocol/SharedEntry';
import type { Block, Inline } from '../lib/markdown';
import { ui } from '../lib/stores/ui.svelte';
import { sharedIndex } from '../lib/stores/sharedIndex.svelte';

// 一覧は偽物（ルートの画像・PDF。later/ は読み込み中のまま保つ）
const pending = new Map<string, () => void>();
const list = vi.fn((dir: string) => {
  if (dir === 'later') return new Promise<SharedEntry[]>((resolve) => pending.set('later', () => resolve(entriesOf('later'))));
  return Promise.resolve(entriesOf(dir));
});
vi.mock('../lib/transport/shared', () => ({ sharedApi: { list: (dir: string) => list(dir) } }));

const entry = (path: string, mime: string | null): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 10,
  modified: 0,
  mime,
  message_id: null,
  file_id: null,
});
function entriesOf(dir: string): SharedEntry[] {
  if (dir === '') return ['image1.png', 'image2.png', 'image3.png', 'image4.png', 'doc.pdf'].map((n) => entry(n, n.endsWith('.png') ? 'image/png' : 'application/pdf'));
  if (dir === 'later') return [entry('later/late.png', 'image/png')];
  return [];
}

const { default: Markdown } = await import('./Markdown.svelte');

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;
beforeEach(() => {
  list.mockClear();
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  ui.lightbox = null;
  ui.lightboxGallery = null;
});

const img = (path: string): Inline => ({ type: 'fileLink', path, alias: null, embed: true });
const text = (t: string): Inline => ({ type: 'text', text: t });
const pdf = (): Inline => ({ type: 'fileLink', path: 'doc.pdf', alias: null, embed: true });

/** 一覧が手元に入るまで待ち、描画し直す（FileLink の読み込みと同じ流れ） */
async function renderTree(tree: Block[]): Promise<void> {
  instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
  flushSync();
  await vi.waitFor(() => {
    for (const p of ['image1.png', 'image2.png', 'image3.png', 'image4.png', 'doc.pdf']) {
      if (sharedIndex.file(p).kind !== 'found') throw new Error('not loaded yet: ' + p);
    }
  });
  await tick();
  flushSync();
}

const rows = () => [...target!.querySelectorAll<HTMLElement>('.embed-row')];
const images = () => [...target!.querySelectorAll<HTMLElement>('.file-link-embed-image')];

describe('本文の画像の埋め込みの横一列', () => {
  it('空白で続く 2 枚は 1 つの横一列の中に並び、間に改行を出さない', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png'), text(' '), img('image2.png')]] }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelectorAll('.file-link-embed-image')).toHaveLength(2);
    expect(target!.querySelectorAll('br')).toHaveLength(0);
  });

  it('改行 1 つで続く 2 枚も 1 つの横一列（行の区切りの改行は出さない）', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png')], [img('image2.png')]] }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelectorAll('.file-link-embed-image')).toHaveLength(2);
    expect(target!.querySelectorAll('br')).toHaveLength(0);
  });

  it('枚数の上限は無く、続く分だけ 1 つの列に入る（横一列は段落の中の子として 1 つ）', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png'), text(' '), img('image2.png'), text(' '), img('image3.png'), text(' '), img('image4.png')]] }]);
    expect(rows()).toHaveLength(1);
    expect(images()).toHaveLength(4);
  });

  it('1 枚だけの埋め込みは横一列にせず、今までどおり段落の中に置く', async () => {
    await renderTree([{ type: 'paragraph', lines: [[text('見て '), img('image1.png'), text(' ね')]] }]);
    expect(rows()).toHaveLength(0);
    expect(images()).toHaveLength(1);
    expect(images()[0].closest('p')).not.toBeNull();
    expect(target!.querySelector('p')!.textContent).toContain('見て');
    expect(target!.querySelector('p')!.textContent).toContain('ね');
  });

  it('文字をはさむと横一列は切れる（それぞれ残る）', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png'), text('と'), img('image2.png')]] }]);
    expect(rows()).toHaveLength(0);
    expect(images()).toHaveLength(2);
    expect(target!.querySelector('p')!.textContent).toContain('と');
  });

  it('画像でない埋め込み（PDF などのカード）は横一列に入らず、そこで切れる', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png'), text(' '), pdf(), text(' '), img('image2.png')]] }]);
    expect(rows()).toHaveLength(0);
    expect(images()).toHaveLength(2);
    expect(target!.querySelectorAll('.file-link-card')).toHaveLength(1);
  });

  it('一覧にまだ無い（読み込み中の）埋め込みは、画像と分かるまで横一列にしない', async () => {
    const tree: Block[] = [{ type: 'paragraph', lines: [[img('later/late.png'), text(' '), img('image1.png')]] }];
    instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree } });
    flushSync();
    await tick();
    expect(rows()).toHaveLength(0);
    pending.get('later')!();
    await vi.waitFor(() => expect(sharedIndex.file('later/late.png').kind).toBe('found'));
    await vi.waitFor(() => expect(sharedIndex.file('image1.png').kind).toBe('found'));
    await tick();
    flushSync();
    expect(rows()).toHaveLength(1);
  });

  it('横一列の画像を押すと、今までどおりチャットの拡大表示を開く', async () => {
    await renderTree([{ type: 'paragraph', lines: [[img('image1.png'), text(' '), img('image2.png')]] }]);
    const spy = vi.spyOn(ui, 'openLightbox');
    images()[1].click();
    expect(spy).toHaveBeenCalledTimes(1);
    const [item] = spy.mock.calls[0];
    expect(item.src).toContain('image2.png');
    spy.mockRestore();
  });

  it('横一列の後ろの文字と、末尾の添え書き（編集済みなど）は行の中に残る', async () => {
    const tree: Block[] = [{ type: 'paragraph', lines: [[img('image1.png'), text(' '), img('image2.png')], [text('あと')]] }];
    instance = mount(Markdown, { target: target!, props: { body: '', markdown: tree, suffix: undefined } });
    flushSync();
    await vi.waitFor(() => expect(sharedIndex.file('image2.png').kind).toBe('found'));
    await tick();
    flushSync();
    expect(rows()).toHaveLength(1);
    expect(target!.querySelector('p:last-child')?.textContent).toContain('あと');
  });
});
