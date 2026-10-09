import { describe, expect, it } from 'vitest';
import { extractMentions, mentionsToText, parse, parseInline, type Block, type Inline } from './markdown';

const t = (text: string): Inline => ({ type: 'text', text });

// 構文木の中に、指定した文字列を含むテキスト以外のノードがないか確かめる
function allText(nodes: (Inline | Block)[]): string {
  let s = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        s += n.text;
        break;
      case 'bold':
      case 'italic':
        s += allText(n.children);
        break;
      case 'link':
        s += n.text;
        break;
      case 'mention':
        s += `<@${n.userId}>`;
        break;
      case 'paragraph':
        s += n.lines.map((l) => allText(l)).join('\n');
        break;
      case 'code':
        s += n.text;
        break;
      case 'quote':
        s += allText(n.children);
        break;
      case 'list':
        s += n.items.map((l) => allText(l)).join('\n');
        break;
    }
  }
  return s;
}

describe('inline', () => {
  it('plain text', () => {
    expect(parseInline('hello world')).toEqual([t('hello world')]);
  });

  it('bold', () => {
    expect(parseInline('a **b** c')).toEqual([t('a '), { type: 'bold', children: [t('b')] }, t(' c')]);
  });

  it('italic with underscore and star', () => {
    expect(parseInline('_x_')).toEqual([{ type: 'italic', children: [t('x')] }]);
    expect(parseInline('*x*')).toEqual([{ type: 'italic', children: [t('x')] }]);
  });

  it('nested emphasis', () => {
    expect(parseInline('**a _b_**')).toEqual([
      { type: 'bold', children: [t('a '), { type: 'italic', children: [t('b')] }] },
    ]);
  });

  it('does not italicize snake_case', () => {
    expect(parseInline('snake_case_name')).toEqual([t('snake_case_name')]);
    expect(parseInline('foo_bar_ baz')).toEqual([t('foo_bar_ baz')]);
  });

  it('unclosed or spaced delimiters stay literal', () => {
    expect(parseInline('**open')).toEqual([t('**open')]);
    expect(parseInline('a * b * c')).toEqual([t('a * b * c')]);
    expect(parseInline('** x**')).toEqual([t('** x**')]);
    expect(parseInline('2*3*4')).toEqual([t('2'), { type: 'italic', children: [t('3')] }, t('4')]);
  });

  it('japanese emphasis', () => {
    expect(parseInline('これは**太字**です')).toEqual([
      t('これは'),
      { type: 'bold', children: [t('太字')] },
      t('です'),
    ]);
  });

  it('autolinks urls and trims trailing punctuation', () => {
    expect(parseInline('see https://example.com/a?b=1.')).toEqual([
      t('see '),
      { type: 'link', href: 'https://example.com/a?b=1', text: 'https://example.com/a?b=1' },
      t('.'),
    ]);
    expect(parseInline('(https://ja.wikipedia.org/wiki/X_(Y))')).toEqual([
      t('('),
      { type: 'link', href: 'https://ja.wikipedia.org/wiki/X_(Y)', text: 'https://ja.wikipedia.org/wiki/X_(Y)' },
      t(')'),
    ]);
  });

  it('url underscores are not italic', () => {
    expect(parseInline('https://a.com/_x_')).toEqual([
      { type: 'link', href: 'https://a.com/_x_', text: 'https://a.com/_x_' },
    ]);
  });

  it('only http(s) links', () => {
    expect(parseInline('javascript:alert(1)')).toEqual([t('javascript:alert(1)')]);
    expect(parseInline('xhttps://a.com')).toEqual([t('xhttps://a.com')]);
    expect(parseInline('https://')).toEqual([t('https://')]);
  });

  it('mentions', () => {
    expect(parseInline('hi <@01JABC> !')).toEqual([t('hi '), { type: 'mention', userId: '01JABC' }, t(' !')]);
    expect(parseInline('**<@u1>**')).toEqual([{ type: 'bold', children: [{ type: 'mention', userId: 'u1' }] }]);
  });

  it('raw html stays as text', () => {
    const src = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    expect(parseInline(src)).toEqual([t(src)]);
  });

  it('link text cannot contain html-breaking characters', () => {
    const nodes = parseInline('https://a.com/"><script>');
    expect(nodes[0]).toEqual({ type: 'link', href: 'https://a.com/', text: 'https://a.com/' });
  });
});

describe('blocks', () => {
  it('paragraph keeps line breaks', () => {
    expect(parse('a\nb\n\nc')).toEqual([
      { type: 'paragraph', lines: [[t('a')], [t('b')]] },
      { type: 'paragraph', lines: [[t('c')]] },
    ]);
  });

  it('fenced code block keeps content literal', () => {
    expect(parse('```ts\nconst a = **1**;\n<b>x</b>\n```\nafter')).toEqual([
      { type: 'code', lang: 'ts', text: 'const a = **1**;\n<b>x</b>' },
      { type: 'paragraph', lines: [[t('after')]] },
    ]);
  });

  it('unclosed fence runs to the end', () => {
    expect(parse('```\ncode')).toEqual([{ type: 'code', lang: '', text: 'code' }]);
  });

  it('code block preserves blank lines and indentation', () => {
    expect(parse('```\n  a\n\n  b\n```')).toEqual([{ type: 'code', lang: '', text: '  a\n\n  b' }]);
  });

  it('quote with nested blocks', () => {
    expect(parse('> hello\n> - x\n>\n> **b**\nout')).toEqual([
      {
        type: 'quote',
        children: [
          { type: 'paragraph', lines: [[t('hello')]] },
          { type: 'list', ordered: false, start: 1, items: [[t('x')]] },
          { type: 'paragraph', lines: [[{ type: 'bold', children: [t('b')] }]] },
        ],
      },
      { type: 'paragraph', lines: [[t('out')]] },
    ]);
  });

  it('unordered list', () => {
    expect(parse('- a\n- **b**\n* c')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [[t('a')], [{ type: 'bold', children: [t('b')] }], [t('c')]] },
    ]);
  });

  it('ordered list with start', () => {
    expect(parse('3. a\n4. b')).toEqual([{ type: 'list', ordered: true, start: 3, items: [[t('a')], [t('b')]] }]);
  });

  it('list immediately after paragraph', () => {
    expect(parse('items:\n1. a')).toEqual([
      { type: 'paragraph', lines: [[t('items:')]] },
      { type: 'list', ordered: true, start: 1, items: [[t('a')]] },
    ]);
  });

  it('unsupported syntax is literal', () => {
    expect(parse('# heading\n| a | b |\n[x](https://y.z)')).toEqual([
      {
        type: 'paragraph',
        lines: [
          [t('# heading')],
          [t('| a | b |')],
          [t('[x]('), { type: 'link', href: 'https://y.z', text: 'https://y.z' }, t(')')],
        ],
      },
    ]);
  });

  it('-text without space is not a list', () => {
    expect(parse('-1 point')).toEqual([{ type: 'paragraph', lines: [[t('-1 point')]] }]);
  });

  it('CRLF', () => {
    expect(parse('a\r\nb')).toEqual([{ type: 'paragraph', lines: [[t('a')], [t('b')]] }]);
  });

  it('never loses or adds text for random input', () => {
    const samples = ['**a**b_c_ <@x> https://q.r/s', '> **x\n- _y\n1. z**', '```\n<script>\n```', '***x***', '_a **b_ c**'];
    for (const s of samples) {
      const out = allText(parse(s));
      // 区切り記号以外の文字はすべて残る
      const strip = (x: string) => x.replace(/[*_>`\-\n\d. ]/g, '');
      expect(strip(out)).toBe(strip(s));
    }
  });
});

describe('helpers', () => {
  it('mentionsToText', () => {
    expect(mentionsToText('hi <@a> and <@b>', (id) => id.toUpperCase())).toBe('hi @A and @B');
  });
  it('extractMentions', () => {
    expect(extractMentions('<@a> <@b> <c>')).toEqual(['a', 'b']);
  });
});
