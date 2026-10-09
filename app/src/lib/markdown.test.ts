import { describe, expect, it } from 'vitest';
import { extractMentions, mentionsToText, parse, parseInline, type Block, type Inline, type ListItem } from './markdown';

const t = (text: string): Inline => ({ type: 'text', text });
const item = (lines: Inline[][], children: Block[] = []): ListItem => ({ lines, children });

// 構文木に含まれる文字をすべて集める（区切り記号は含まない）
function allText(nodes: (Inline | Block)[]): string {
  let s = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        s += n.text;
        break;
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strike':
      case 'highlight':
        s += allText(n.children);
        break;
      case 'code':
        s += n.text;
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
      case 'quote':
        s += allText(n.children);
        break;
      case 'list':
        s += n.items.map((it) => allText(it.lines.flat()) + allText(it.children)).join('\n');
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

  it('mention ids with underscore do not start italic', () => {
    expect(parseInline('_a <@u_1> b_')).toEqual([
      { type: 'italic', children: [t('a '), { type: 'mention', userId: 'u_1' }, t(' b')] },
    ]);
  });

  it('raw html stays as text', () => {
    const src = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    expect(parseInline(src)).toEqual([t(src)]);
  });

  it('link text cannot contain html-breaking characters', () => {
    const nodes = parseInline('https://a.com/"><script>');
    expect(nodes[0]).toEqual({ type: 'link', href: 'https://a.com/', text: 'https://a.com/' });
  });

  it('underline with double underscore', () => {
    expect(parseInline('__u__')).toEqual([{ type: 'underline', children: [t('u')] }]);
    expect(parseInline('a __b c__ d')).toEqual([t('a '), { type: 'underline', children: [t('b c')] }, t(' d')]);
  });

  it('double underscore inside a word is not underline', () => {
    expect(parseInline('__init__')).toEqual([{ type: 'underline', children: [t('init')] }]);
    expect(parseInline('my__var__name')).toEqual([t('my__var__name')]);
  });

  it('strikethrough', () => {
    expect(parseInline('~~x~~')).toEqual([{ type: 'strike', children: [t('x')] }]);
    expect(parseInline('a ~~ b ~~ c')).toEqual([t('a ~~ b ~~ c')]);
    expect(parseInline('~~open')).toEqual([t('~~open')]);
  });

  it('highlight', () => {
    expect(parseInline('==hi==')).toEqual([{ type: 'highlight', children: [t('hi')] }]);
    expect(parseInline('==**b**==')).toEqual([
      { type: 'highlight', children: [{ type: 'bold', children: [t('b')] }] },
    ]);
    expect(parseInline('a == b')).toEqual([t('a == b')]);
  });

  it('inline code keeps markup literal', () => {
    expect(parseInline('`**x** _y_`')).toEqual([{ type: 'code', text: '**x** _y_' }]);
    expect(parseInline('`<@u1>` https://a.com')).toEqual([
      { type: 'code', text: '<@u1>' },
      t(' '),
      { type: 'link', href: 'https://a.com', text: 'https://a.com' },
    ]);
  });

  it('code span hides delimiters from emphasis closing', () => {
    expect(parseInline('*a `b*` c*')).toEqual([
      { type: 'italic', children: [t('a '), { type: 'code', text: 'b*' }, t(' c')] },
    ]);
  });

  it('unclosed backtick is literal', () => {
    expect(parseInline('`abc')).toEqual([t('`abc')]);
  });

  it('backslash escapes punctuation', () => {
    expect(parseInline('\\_a\\_')).toEqual([t('_a_')]);
    expect(parseInline('\\*\\*x\\*\\*')).toEqual([t('**x**')]);
    expect(parseInline('\\`no\\`')).toEqual([t('`no`')]);
    expect(parseInline('a\\b')).toEqual([t('a\\b')]);
  });

  it('escaped delimiter does not close emphasis', () => {
    expect(parseInline('_a\\_ b_')).toEqual([{ type: 'italic', children: [t('a_ b')] }]);
  });

  it('markdown link', () => {
    expect(parseInline('[文字](https://example.com/a?b=1)です')).toEqual([
      { type: 'link', href: 'https://example.com/a?b=1', text: '文字' },
      t('です'),
    ]);
  });

  it('markdown link href may contain balanced parentheses', () => {
    expect(parseInline('[w](https://ja.wikipedia.org/wiki/X_(Y))')).toEqual([
      { type: 'link', href: 'https://ja.wikipedia.org/wiki/X_(Y)', text: 'w' },
    ]);
  });

  it('markdown link rejects unsafe or non-http hrefs', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([t('[x](javascript:alert(1))')]);
    expect(parseInline('[x](ftp://a.com)')).toEqual([t('[x](ftp://a.com)')]);
    // 不正なリンクは素のテキスト。中の URL は従来どおり安全な自動リンクになる
    expect(parseInline('[x](https://a.com"onmouseover=1)')).toEqual([
      t('[x]('),
      { type: 'link', href: 'https://a.com', text: 'https://a.com' },
      t('"onmouseover=1)'),
    ]);
    expect(parseInline('[x](https://a.com b)')).toEqual([
      t('[x]('),
      { type: 'link', href: 'https://a.com', text: 'https://a.com' },
      t(' b)'),
    ]);
  });

  it('markdown link needs non-empty text and a closing paren', () => {
    expect(parseInline('[](https://a.com)')).toEqual([
      t('[]('),
      { type: 'link', href: 'https://a.com', text: 'https://a.com' },
      t(')'),
    ]);
    expect(parseInline('[x](https://a.com')).toEqual([
      t('[x]('),
      { type: 'link', href: 'https://a.com', text: 'https://a.com' },
    ]);
  });

  it('markdown link text is not parsed for emphasis', () => {
    expect(parseInline('[**x**](https://a.com)')).toEqual([{ type: 'link', href: 'https://a.com', text: '**x**' }]);
  });

  it('delimiters inside a markdown link do not leak out', () => {
    expect(parseInline('*a [b*](https://a.com) c*')).toEqual([
      { type: 'italic', children: [t('a '), { type: 'link', href: 'https://a.com', text: 'b*' }, t(' c')] },
    ]);
  });

  it('html inside markdown link text stays text', () => {
    const nodes = parseInline('[<b>x</b>](https://a.com)');
    expect(nodes).toEqual([{ type: 'link', href: 'https://a.com', text: '<b>x</b>' }]);
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

  it('code block keeps tabs', () => {
    expect(parse('```\n\tx\n```')).toEqual([{ type: 'code', lang: '', text: '\tx' }]);
  });

  it('quote with nested blocks', () => {
    expect(parse('> hello\n> - x\n>\n> **b**\nout')).toEqual([
      {
        type: 'quote',
        children: [
          { type: 'paragraph', lines: [[t('hello')]] },
          { type: 'list', ordered: false, start: 1, items: [item([[t('x')]])] },
          { type: 'paragraph', lines: [[{ type: 'bold', children: [t('b')] }]] },
        ],
      },
      { type: 'paragraph', lines: [[t('out')]] },
    ]);
  });

  it('unordered list', () => {
    expect(parse('- a\n- **b**\n* c')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [item([[t('a')]]), item([[{ type: 'bold', children: [t('b')] }]]), item([[t('c')]])],
      },
    ]);
  });

  it('plus marker is a list too', () => {
    expect(parse('+ list\n* list')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [item([[t('list')]]), item([[t('list')]])] },
    ]);
  });

  it('ordered list with start', () => {
    expect(parse('3. a\n4. b')).toEqual([{ type: 'list', ordered: true, start: 3, items: [item([[t('a')]]), item([[t('b')]])] }]);
  });

  it('ordered list with parenthesis marker', () => {
    expect(parse('1) a')).toEqual([{ type: 'list', ordered: true, start: 1, items: [item([[t('a')]])] }]);
  });

  it('list immediately after paragraph', () => {
    expect(parse('items:\n1. a')).toEqual([
      { type: 'paragraph', lines: [[t('items:')]] },
      { type: 'list', ordered: true, start: 1, items: [item([[t('a')]])] },
    ]);
  });

  it('nested lists by indentation, mixed ordered and unordered', () => {
    const src = '+ list\n* list\n- nested\n  - list\n    1. nested\n      1. ordered';
    expect(parse(src)).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          item([[t('list')]]),
          item([[t('list')]]),
          item([[t('nested')]], [
            {
              type: 'list',
              ordered: false,
              start: 1,
              items: [
                item([[t('list')]], [
                  {
                    type: 'list',
                    ordered: true,
                    start: 1,
                    items: [
                      item([[t('nested')]], [
                        { type: 'list', ordered: true, start: 1, items: [item([[t('ordered')]])] },
                      ]),
                    ],
                  },
                ]),
              ],
            },
          ]),
        ],
      },
    ]);
  });

  it('nested list items keep their own start number', () => {
    expect(parse('1. a\n   5. b')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 1,
        items: [item([[t('a')]], [{ type: 'list', ordered: true, start: 5, items: [item([[t('b')]])] }])],
      },
    ]);
  });

  it('a marker at a shallower indent closes the nested list', () => {
    expect(parse('- a\n  - b\n- c')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          item([[t('a')]], [{ type: 'list', ordered: false, start: 1, items: [item([[t('b')]])] }]),
          item([[t('c')]]),
        ],
      },
    ]);
  });

  it('a different marker kind at the same indent starts a new list', () => {
    expect(parse('- a\n1. b')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [item([[t('a')]])] },
      { type: 'list', ordered: true, start: 1, items: [item([[t('b')]])] },
    ]);
  });

  it('blank line between items keeps one list', () => {
    expect(parse('1. a\n\n2. b')).toEqual([
      { type: 'list', ordered: true, start: 1, items: [item([[t('a')]]), item([[t('b')]])] },
    ]);
  });

  it('continuation line of an item joins the item text', () => {
    expect(parse('- a\n  b\n- c')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [item([[t('a')], [t('b')]]), item([[t('c')]])] },
    ]);
  });

  it('list item with a code block', () => {
    expect(parse('- a\n  ```\n  x\n  ```')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [item([[t('a')]], [{ type: 'code', lang: '', text: 'x' }])] },
    ]);
  });

  it('list item text with inline markup', () => {
    expect(parse('- ~~a~~ `b` [c](https://c.d)')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          item([
            [
              { type: 'strike', children: [t('a')] },
              t(' '),
              { type: 'code', text: 'b' },
              t(' '),
              { type: 'link', href: 'https://c.d', text: 'c' },
            ],
          ]),
        ],
      },
    ]);
  });

  it('unsupported syntax is literal', () => {
    expect(parse('# heading\n| a | b |')).toEqual([
      { type: 'paragraph', lines: [[t('# heading')], [t('| a | b |')]] },
    ]);
  });

  it('-text without space is not a list', () => {
    expect(parse('-1 point')).toEqual([{ type: 'paragraph', lines: [[t('-1 point')]] }]);
  });

  it('CRLF', () => {
    expect(parse('a\r\nb')).toEqual([{ type: 'paragraph', lines: [[t('a')], [t('b')]] }]);
  });

  it('never loses or adds text for random input', () => {
    const samples = [
      '**a**b_c_ <@x> https://q.r/s',
      '> **x\n- _y\n1. z**',
      '```\n<script>\n```',
      '***x***',
      '_a **b_ c**',
      '- a\n  - ~~b~~\n    1. ==c== __d__',
      '+ e `h`\n\n1. i',
    ];
    for (const s of samples) {
      const out = allText(parse(s));
      // 区切り記号以外の文字はすべて残る
      const strip = (x: string) => x.replace(/[*_>`+\-\n\d. ~=]/g, '');
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
