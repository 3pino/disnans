// 本文の木の部品（プレーンの木・木の選び方・メンション）。Markdown の解析は Rust（core）の fixture で確かめる。
import { describe, expect, it } from 'vitest';
import { mentionIds, mentionsToText, plainTree, setTree, treeOf, treeOfMessage, type Block, type Inline } from './markdown';

const t = (text: string): Inline => ({ type: 'text', text });

describe('plainTree（木が無いときの表示）', () => {
  it('空の本文は何も出さない', () => {
    expect(plainTree('')).toEqual([]);
  });

  it('書式は解釈せず、そのまま一段落にする', () => {
    expect(plainTree('a **b** _c_ `d`')).toEqual([{ type: 'paragraph', lines: [[t('a **b** _c_ `d`')]] }]);
  });

  it('改行は行に分ける（CRLF・CR も同じ）。空の行は空の行として残す', () => {
    const expected: Block[] = [{ type: 'paragraph', lines: [[t('a')], [], [t('b')]] }];
    expect(plainTree('a\n\nb')).toEqual(expected);
    expect(plainTree('a\r\n\r\nb')).toEqual(expected);
    expect(plainTree('a\r\rb')).toEqual([{ type: 'paragraph', lines: [[t('a')], [], [t('b')]] }]);
  });

  it('<@id> だけはメンションにする（名前は描画側）', () => {
    expect(plainTree('hi <@u1> and <@u-2>!')).toEqual([
      {
        type: 'paragraph',
        lines: [[t('hi '), { type: 'mention', userId: 'u1' }, t(' and '), { type: 'mention', userId: 'u-2' }, t('!')]],
      },
    ]);
  });

  it('形の合わない <@…> は文字のまま', () => {
    expect(plainTree('<@> <@a b> <x>')).toEqual([{ type: 'paragraph', lines: [[t('<@> <@a b> <x>')]] }]);
  });
});

describe('treeOf（どの木を使うか）', () => {
  it('Rust が作った木（配列）があれば、そのまま使う', () => {
    const rust: Block[] = [{ type: 'paragraph', lines: [[{ type: 'bold', children: [t('from rust')] }]] }];
    expect(treeOf('ignored', rust)).toBe(rust);
  });

  it('配列でなければ、本文のプレーンの木にする', () => {
    expect(treeOf('a **b**')).toEqual(plainTree('a **b**'));
    expect(treeOf('a **b**', undefined)).toEqual(plainTree('a **b**'));
    expect(treeOf('a **b**', null)).toEqual(plainTree('a **b**'));
    expect(treeOf('a **b**', 'not a tree')).toEqual(plainTree('a **b**'));
  });

  it('メッセージの木は markdown を使い、無ければ本文から作る', () => {
    const rust: Block[] = [{ type: 'paragraph', lines: [[t('x')]] }];
    expect(treeOfMessage({ body: 'y', markdown: rust })).toBe(rust);
    expect(treeOfMessage({ body: 'y' })).toEqual(plainTree('y'));
  });
});

describe('setTree（仮表示の木を付ける・外す）', () => {
  it('木を付けると描画に使われ、undefined で外すと本文のプレーンに戻る', () => {
    const m: { body: string; markdown?: Block[] } = { body: 'a **b**' };
    const tree: Block[] = [{ type: 'paragraph', lines: [[{ type: 'bold', children: [t('b')] }]] }];
    setTree(m, tree);
    expect(treeOfMessage(m)).toBe(tree);
    setTree(m, undefined);
    expect(treeOfMessage(m)).toEqual(plainTree('a **b**'));
  });
});

describe('メンション', () => {
  it('mentionsToText は <@id> を @名前 にする', () => {
    expect(mentionsToText('hi <@a> and <@b>', (id) => id.toUpperCase())).toBe('hi @A and @B');
  });

  it('mentionIds は木の中の全部のメンションを出現順に集める（入れ子も）', () => {
    const tree: Block[] = [
      { type: 'paragraph', lines: [[{ type: 'bold', children: [{ type: 'mention', userId: 'a' }] }], [t('x')]] },
      {
        type: 'quote',
        children: [{ type: 'paragraph', lines: [[{ type: 'mention', userId: 'b' }]] }],
      },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [{ lines: [[{ type: 'italic', children: [{ type: 'mention', userId: 'c' }] }]], children: [{ type: 'paragraph', lines: [[{ type: 'mention', userId: 'd' }]] }] }],
      },
    ];
    expect(mentionIds(tree)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ファイルのリンクと本文の文字はメンションではない', () => {
    const tree: Block[] = [
      { type: 'paragraph', lines: [[{ type: 'fileLink', path: 'attachments/a.png', alias: 'a', embed: true }, t('<@x>')]] },
    ];
    expect(mentionIds(tree)).toEqual([]);
  });

  it('送信中の木（プレーン）でも、本文のメンションを拾える', () => {
    expect(mentionIds(treeOf('<@m1> hi'))).toEqual(['m1']);
  });
});
