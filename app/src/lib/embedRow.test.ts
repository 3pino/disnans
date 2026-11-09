// 画像の埋め込みの横一列（段落の行を表示の区切りに分ける）。Svelte に依らない判断だけを確かめる
import { describe, expect, it } from 'vitest';
import { embedRowSegments } from './embedRow';
import type { Inline } from './markdown';

const img = (path: string): Inline => ({ type: 'fileLink', path, alias: null, embed: true });
const file = (path: string): Inline => ({ type: 'fileLink', path, alias: null, embed: true });
const text = (t: string): Inline => ({ type: 'text', text: t });
const link = (path: string): Inline => ({ type: 'fileLink', path, alias: null, embed: false });

/** 画像の埋め込みは「パスが image で始まるもの」とみなす（判断の入力だけを固定する） */
const isImage = (n: Inline) => n.type === 'fileLink' && n.embed && n.path.startsWith('image');

const run = (lines: Inline[][]) => embedRowSegments(lines, isImage);

/** 段落の表示を読みやすい形にする（row の中身は path、nodes は文字） */
function brief(segs: ReturnType<typeof run>): string[] {
  return segs.map((s) => {
    if (s.kind === 'break') return 'BR';
    if (s.kind === 'row') return 'ROW[' + s.items.map((n) => (n.type === 'fileLink' ? n.path : '?')).join(',') + ']';
    return 'NODES[' + s.nodes.map((n) => (n.type === 'text' ? JSON.stringify(n.text) : n.type === 'fileLink' ? n.path : n.type)).join(',') + ']';
  });
}

describe('画像の埋め込みの横一列', () => {
  it('空白だけで続く 2 枚は 1 つの横一列', () => {
    expect(brief(run([[img('image1.png'), text(' '), img('image2.png')]]))).toEqual(['ROW[image1.png,image2.png]']);
  });

  it('改行 1 つで続く 2 枚も 1 つの横一列（行の区切りは出さない）', () => {
    expect(brief(run([[img('image1.png')], [img('image2.png')]]))).toEqual(['ROW[image1.png,image2.png]']);
  });

  it('続く枚数だけ横一列に入る（上限は無い）', () => {
    const many = Array.from({ length: 12 }, (_, i) => img(`image${i}.png`));
    const segs = run([many]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: 'row', items: many });
  });

  it('1 枚だけの埋め込みは今までどおり（横一列にしない）', () => {
    expect(brief(run([[text('見て '), img('image1.png'), text(' ね')]]))).toEqual(['NODES["見て ",image1.png," ね"]']);
  });

  it('文字をはさむと切れる（横一列は別々）。1 枚ずつは残る', () => {
    expect(brief(run([[img('image1.png'), text('と'), img('image2.png')]]))).toEqual([
      'NODES[image1.png,"と",image2.png]',
    ]);
  });

  it('横一列の前後の文字は、横一列の外に残る', () => {
    expect(brief(run([[text('前'), img('image1.png'), text(' '), img('image2.png'), text('後')]]))).toEqual([
      'NODES["前"]',
      'ROW[image1.png,image2.png]',
      'NODES["後"]',
    ]);
  });

  it('横一列の前の改行・空白は捨てる。後ろの改行も捨てる', () => {
    expect(brief(run([[text('前')], [img('image1.png'), text(' '), img('image2.png')], [text('後')]]))).toEqual([
      'NODES["前"]',
      'ROW[image1.png,image2.png]',
      'NODES["後"]',
    ]);
  });

  it('改行が 2 つ続く（段落の中では普通は起きない）と切れる', () => {
    expect(brief(run([[img('image1.png')], [], [img('image2.png')]]))).toEqual([
      'NODES[image1.png]',
      'BR',
      'BR',
      'NODES[image2.png]',
    ]);
  });

  it('ファイルリンク（埋め込みでない）・カード（画像でない埋め込み）は横一列に入らず、そこで切れる', () => {
    expect(brief(run([[img('image1.png'), text(' '), link('image2.png'), text(' '), img('image3.png')]]))).toEqual([
      'NODES[image1.png," ",image2.png," ",image3.png]',
    ]);
    expect(brief(run([[img('image1.png'), text(' '), file('doc.pdf'), text(' '), img('image3.png')]]))).toEqual([
      'NODES[image1.png," ",doc.pdf," ",image3.png]',
    ]);
  });

  it('横一列が 2 つ続くとき、間に文字があれば別々の横一列', () => {
    expect(brief(run([[img('image1.png'), text(' '), img('image2.png'), text('。'), img('image3.png'), text(' '), img('image4.png')]]))).toEqual([
      'ROW[image1.png,image2.png]',
      'NODES["。"]',
      'ROW[image3.png,image4.png]',
    ]);
  });

  it('横一列の後の空白でない文字は、横一列の外に残る（前の空白は捨てる）', () => {
    expect(brief(run([[img('image1.png'), text('  '), img('image2.png'), text(' 続き')]]))).toEqual([
      'ROW[image1.png,image2.png]',
      'NODES[" 続き"]',
    ]);
  });

  it('文字だけの段落・空の行は今までどおり（nodes と改行だけ）', () => {
    expect(brief(run([[text('a')], [text('b')]]))).toEqual(['NODES["a"]', 'BR', 'NODES["b"]']);
    expect(run([])).toEqual([]);
  });

  it('画像の埋め込みの判断は呼び出し側が決める（画像でない埋め込みは isImage が偽ならそのまま）', () => {
    const segs = embedRowSegments([[img('image1.png'), text(' '), img('image2.png')]], () => false);
    expect(brief(segs)).toEqual(['NODES[image1.png," ",image2.png]']);
  });
});
