// @vitest-environment jsdom
// disnans.ui は、共有の UI 部品（Svelte）を mount して DOM の要素を渡す。その作りと後始末（ui/mount.ts・ui/detachedEvents.ts）を、プラグインから見える形で確かめる:
//  - 文字・要素の入れ方、押す・入力するがつながる前の要素でも効くこと（二重に呼ばれないこと）
//  - 状態が自分で切り替わること（トグル・セグメント・ナビ・スライダー）
//  - 画面から外れた要素の片付け（unmount）と、プラグインを外したときの片付け
//  - 本体の Svelte の部品と、同じ DOM になること（設定の行）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import SettingRow from '@3pino/ui-kit-web/SettingRow.svelte';
import Toggle from '@3pino/ui-kit-web/Toggle.svelte';
import { registerIcon } from '@3pino/ui-kit-web/icons';
import { createUi } from './ui';
import { mountedCount, releaseAll, releaseDetached, sweep } from './ui/mount';
import { setLucideForTest } from '../icons.svelte';
import Host from './ui/test/Host.svelte';

const ui = createUi({ toast: vi.fn(), confirm: async () => true });

beforeEach(() => setLucideForTest({ Puzzle: [['path', { d: 'M1 1' }]] } as never));
afterEach(() => {
  releaseAll();
  document.body.innerHTML = '';
  setLucideForTest(null);
  vi.useRealTimers();
});

const attach = <T extends Element>(el: T): T => {
  document.body.append(el);
  return el;
};

describe('中身の入れ方', () => {
  it('文字列は文字として入り、要素はそのまま（同じ要素・付けたリスナーも生きる）入る。順序もそのまま', () => {
    const own = document.createElement('b');
    const fn = vi.fn();
    own.addEventListener('click', fn);
    own.textContent = '強い';
    const el = ui.statusLine({ children: ['<i>a</i>', own, '末尾'] });
    expect(el.querySelector('i')).toBeNull();
    expect(el.lastElementChild).toBe(own);
    expect(el.textContent).toBe('<i>a</i>強い末尾');
    attach(el);
    own.click();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(el.querySelector('template')).toBeNull();
  });

  it('同じ要素を 2 つの部品に渡すと、あとのものへ移る（DOM の append と同じ）', () => {
    const own = document.createElement('b');
    const a = ui.section({ title: 'A', children: own });
    const b = ui.section({ title: 'B', children: own });
    expect(a.contains(own)).toBe(false);
    expect(b.lastElementChild).toBe(own);
  });

  it('文字・class は、書いたとおり（部品の書き方で入る空白は取り除く）', () => {
    const b = ui.button({ text: '保存', icon: 'puzzle', variant: 'primary' });
    expect(b.textContent).toBe('保存');
    expect(b.className).toBe('btn primary');
    expect(ui.button({ icon: 'puzzle', label: 'x' }).className).toBe('btn btn-icon-only');
    expect(ui.input({ value: 'a', placeholder: 'p' }).className).toBe('input');
  });
});

describe('つながる前の要素でも、押す・入力するが効く', () => {
  it('つながっていなくても、ハンドラが 1 回だけ呼ばれる。つないだあとも 1 回だけ', () => {
    const fn = vi.fn();
    const b = ui.button({ text: 'a', onClick: fn });
    b.click();
    expect(fn).toHaveBeenCalledTimes(1);
    attach(b).click();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('入れ子（設定の行の中のトグル）でも二重に呼ばれない。つながっていなくても切り替わる', () => {
    const fn = vi.fn();
    const t = ui.toggle({ value: false, onChange: fn });
    const box = document.createElement('div');
    ui.setting(box, { name: 'n', control: t });
    t.click();
    expect(fn.mock.calls).toEqual([[true]]);
    expect(t.getAttribute('aria-checked')).toBe('true');
    expect(t.classList.contains('toggle-on')).toBe(true);
    attach(box);
    t.click();
    expect(fn.mock.calls).toEqual([[true], [false]]);
    expect(t.classList.contains('toggle-on')).toBe(false);
  });

  it('入力の通知（バブリングしないイベントでも）。Slider の input・change', () => {
    const log: string[] = [];
    const s = ui.slider({ label: 's', max: 10, onInput: (v) => log.push(`i${v}`), onChange: (v) => log.push(`c${v}`) });
    const input = s.querySelector('input')!;
    input.value = '4';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    expect(log).toEqual(['i4', 'c4']);
    input.value = '6';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(log).toEqual(['i4', 'c4', 'i6']);
  });

  it('input: 打つたびに onChange（つながっていなくても）。値は DOM のまま読み書きできる', () => {
    const fn = vi.fn();
    const el = ui.input({ value: 'a', onChange: fn });
    el.value = 'ab';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fn).toHaveBeenCalledWith('ab');
    expect(el.value).toBe('ab');
  });

  it('押せない（disabled）ボタンは呼ばれない', () => {
    const fn = vi.fn();
    const b = ui.button({ text: 'a', disabled: true, onClick: fn });
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fn).not.toHaveBeenCalled();
  });

  it('ハンドラの例外は、ほかの動きを止めない（非同期に報告される）', () => {
    vi.useFakeTimers();
    const b = ui.button({ text: 'a', onClick: () => { throw new Error('x'); } });
    expect(() => b.click()).not.toThrow();
    expect(() => vi.runAllTimers()).toThrow('x');
  });
});

describe('状態は、押した直後に見た目へ出る', () => {
  it('トグル・セグメント・ナビ・スライダー（コールバックが見る時点で、もう切り替わっている）', () => {
    const seen: string[] = [];
    const t = attach(ui.toggle({ value: false, onChange: () => seen.push(String(t.classList.contains('toggle-on'))) }));
    t.click();
    expect(seen).toEqual(['true']);

    const seg = attach(
      ui.segmented({
        value: 'a',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        onChange: () => seen.push(seg.querySelector('[aria-checked="true"]')!.textContent!),
      }),
    );
    seg.querySelectorAll('button')[1].click();
    expect(seen).toEqual(['true', 'B']);

    const nav = attach(
      ui.navbar({
        selected: 'a',
        items: [{ id: 'a', label: 'A', icon: 'puzzle' }, { id: 'b', label: 'B', icon: 'puzzle' }],
        onSelect: () => seen.push(nav.querySelector('[aria-current="page"]')!.textContent!),
      }),
    );
    nav.querySelectorAll('button')[1].click();
    expect(seen.at(-1)).toBe('B');

    const sl = attach(ui.slider({ label: 's', format: (v) => `${v}!`, onInput: () => seen.push(sl.querySelector('.slider-value')!.textContent!) }));
    const input = sl.querySelector('input')!;
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(seen.at(-1)).toBe('7!');
  });
});

describe('アイコン', () => {
  it('ui.icon は、あとから登録された名前も描き直す（本体の部品と同じ）', () => {
    const el = attach(ui.icon('late-icon', { size: 20 }));
    expect(el.innerHTML).toBe('');
    const off = registerIcon('late-icon', '<path d="M9 9"/>');
    flushSync();
    expect(el.innerHTML).toContain('M9 9');
    expect(el.getAttribute('width')).toBe('20');
    expect(el.classList.contains('icon')).toBe(true);
    off();
  });
});

describe('Svelte の効果の中から呼んでもよい', () => {
  it('onMount の中で作っても例外にならず、効果のあとにアイコンが描かれる', async () => {
    let made: HTMLElement | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const app = mount(Host, { target: host, props: { make: () => (made = ui.button({ text: 'a', icon: 'puzzle' })) } });
    await Promise.resolve();
    flushSync();
    expect(made?.querySelector('svg path')?.getAttribute('d')).toBe('M1 1');
    void unmount(app);
  });
});

describe('本体の Svelte の部品と同じ DOM', () => {
  const shape = (n: Node): string =>
    n instanceof Element
      ? `<${n.tagName.toLowerCase()} class="${[...n.classList].filter((c) => !/^svelte-/.test(c)).sort().join(' ')}">${[...n.childNodes].map(shape).join('')}`
      : n.nodeType === Node.TEXT_NODE
        ? (n.textContent ?? '').trim()
        : '';

  it('ui.setting の行は、SettingRow を直接 mount したものと同じ形（操作の包み div もある）', () => {
    const box = document.createElement('div');
    const row = ui.setting(box, { name: '音', description: '説明', icon: 'puzzle', control: ui.toggle({ value: true, label: '音' }) });
    expect(row.querySelector('.setting-row-control > .setting-row-control-slot > .toggle')).not.toBeNull();
    // 同じ DOM を作る部品（SettingRow）を、操作に別の要素を入れて直接 mount して比べる

    const host = document.createElement('div');
    document.body.append(host);
    const direct = mount(SettingRow, {
      target: host,
      props: {
        name: '音',
        description: '説明',
        icon: 'puzzle',
        control: createRawSnippet(() => ({ render: () => '<span class="ctl">c</span>' })),
      },
    });
    flushSync();
    // 構造（行の直下）だけを比べる: アイコン・情報・操作の順で、同じクラス
    const kids = (e: Element) => [...e.children].map((c) => [...c.classList].filter((x) => !/^svelte-/.test(x)).join(' '));
    expect(kids(row)).toEqual(kids(host.firstElementChild!));
    expect(shape(row.querySelector('.setting-row-info')!)).toBe(shape(host.querySelector('.setting-row-info')!));
    void unmount(direct);
  });

  it('ui.toggle は Toggle を直接 mount したものと同じ形', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const direct = mount(Toggle, { target: host, props: { checked: true, label: 'x' } });
    flushSync();
    expect(shape(ui.toggle({ value: true, label: 'x' }))).toBe(shape(host.firstElementChild!));
    void unmount(direct);
  });
});

describe('画面から外れた要素の片付け', () => {
  it('つながったことがあり、30 秒以上外れたままのものは unmount する。その後も要素は残り、コールバックは呼ばれるが、見た目の切り替えは止まる', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = ui.toggle({ value: false, onChange: fn });
    const box = attach(document.createElement('div'));
    box.append(t);
    vi.advanceTimersByTime(10_000);
    expect(mountedCount()).toBe(1);
    box.remove();
    // 外れてすぐ・しばらくは、まだ生きている（付け替えても使える）
    vi.advanceTimersByTime(20_000);
    expect(mountedCount()).toBe(1);
    attach(box);
    vi.advanceTimersByTime(60_000);
    expect(mountedCount()).toBe(1);
    t.click();
    expect(t.classList.contains('toggle-on')).toBe(true);

    box.remove();
    vi.advanceTimersByTime(50_000);
    expect(mountedCount()).toBe(0);
    // 片付けたあとも、要素は親の中に残る
    expect(box.contains(t)).toBe(true);
    const cls = t.className;
    t.click();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(t.className).toBe(cls);
  });

  it('一度もつながらないままのものは、5 分たつまで残し、そのあと片付ける。タイマーも止まる', () => {
    vi.useFakeTimers();
    ui.button({ text: 'a' });
    vi.advanceTimersByTime(4 * 60_000);
    expect(mountedCount()).toBe(1);
    vi.advanceTimersByTime(2 * 60_000);
    expect(mountedCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('つないで、すぐ（次の処理で）外したものも片付く（つながった瞬間を見逃さない）', async () => {
    const b = ui.button({ text: 'a' });
    attach(b);
    await Promise.resolve();
    b.remove();
    releaseDetached();
    expect(mountedCount()).toBe(0);
  });

  it('プラグインを外したとき: 外れたものは待たずに片付け、つながっているもの・まだつなげていないものは残す', async () => {
    const live = attach(ui.button({ text: 'live' }));
    const gone = ui.button({ text: 'gone' });
    attach(gone);
    const fresh = ui.button({ text: 'fresh' });
    await Promise.resolve();
    gone.remove();
    expect(mountedCount()).toBe(3);
    releaseDetached();
    expect(mountedCount()).toBe(2);
    expect(live.isConnected).toBe(true);
    expect(fresh.isConnected).toBe(false);
  });

  it('unmount で、部品のなかの購読が外れる（アイコンの更新が、外れた要素へ届かない）', async () => {
    const t = ui.button({ text: 'a', icon: 'late2' });
    attach(t);
    await Promise.resolve();
    const off = registerIcon('late2', '<path d="M5 5"/>');
    flushSync();
    expect(t.innerHTML).toContain('M5 5');
    t.remove();
    releaseDetached();
    off();
    registerIcon('late2', '<path d="M6 6"/>');
    flushSync();
    expect(t.innerHTML).toContain('M5 5');
    expect(t.innerHTML).not.toContain('M6 6');
  });

  it('プラグインの木の中にある要素は、片付けで動かない（親・位置はそのまま）', () => {
    const a = ui.button({ text: 'a' });
    const b = ui.button({ text: 'b' });
    const box = attach(document.createElement('div'));
    box.append(a, b);
    sweep(Date.now());
    box.remove();
    sweep(Date.now() + 1);
    sweep(Date.now() + 60_000);
    expect(mountedCount()).toBe(0);
    expect([...box.children]).toEqual([a, b]);
  });

  it('PluginHost が外す（unload）と、外れた部品の片付けも行う', async () => {
    vi.resetModules();
    vi.doMock('../call/instance.svelte', () => ({ callApi: {} }));
    const { PluginHost } = await import('./host.svelte');
    const mountMod = await import('./ui/mount');
    const ui2 = (await import('./ui')).createUi({ toast: vi.fn(), confirm: async () => true });
    const b = attach(ui2.button({ text: 'a' }));
    await Promise.resolve();
    b.remove();
    expect(mountMod.mountedCount()).toBe(1);
    const host = new PluginHost();
    (host as unknown as { loaded: Map<string, unknown> }).loaded.set('p', { runtime: { stop: vi.fn() }, style: null });
    (host as unknown as { unload(id: string): void }).unload('p');
    expect(mountMod.mountedCount()).toBe(0);
    vi.doUnmock('../call/instance.svelte');
  });

  it('重ねて出すメニュー・モーダルは、片付けの対象ではなく、閉じると unmount される（Esc の待ちも外れる）', () => {
    const onClose = vi.fn();
    const h = ui.modal({ title: 't', onClose });
    expect(mountedCount()).toBe(0);
    h.close();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
