// @vitest-environment jsdom
// disnans.ui の API v18（iconButton・section・statusLine・slider・menu・modal）を、プラグインから呼ぶ形で確かめる。
// 部品の DOM が Svelte の部品と同じになることは @3pino/ui-kit-web の試験が見る。ここは、引数の確かめ・文字として入ること・
// 後始末（プラグインを外す・close）・戻る操作・エラーの種類を見る
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePluginOverlays, createUi } from './ui';
import { PluginError } from './errors';
import { setLucideForTest } from '../icons.svelte';
import { ui as hostUi } from '../stores/ui.svelte';

// 戻る操作は、本体の ui ストア（addPluginBack / back）を実物で使う
const ui = createUi({ toast: vi.fn(), confirm: async () => true, onBack: (run) => hostUi.addPluginBack(run) });

beforeEach(() => {
  hostUi.pluginBack = [];
  setLucideForTest({ Puzzle: [['path', { d: 'M1 1' }]], Settings: [['path', { d: 'M2 2' }]] } as never);
});
afterEach(() => {
  closePluginOverlays();
  document.body.innerHTML = '';
  setLucideForTest(null);
});

function invalidArg(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PluginError);
  expect((err as PluginError).code).toBe('invalid_argument');
}

function anchor(): HTMLButtonElement {
  const b = document.createElement('button');
  document.body.append(b);
  return b;
}

describe('ui.iconButton', () => {
  it('名前（aria-label）・アイコン・押下・active・disabled・class', () => {
    const onClick = vi.fn();
    const b = ui.iconButton({ label: '設定', icon: 'settings', active: true, disabled: false, class: 'mine', onClick });
    expect(b.className).toBe('icon-btn mine active');
    expect(b.getAttribute('aria-label')).toBe('設定');
    expect(b.firstElementChild?.getAttribute('width')).toBe('18');
    b.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick.mock.calls[0]).toEqual([]);
    expect(ui.iconButton({ label: 'a', icon: 'settings', iconSize: 24 }).firstElementChild?.getAttribute('width')).toBe('24');
    expect(ui.iconButton({ label: 'a', disabled: true }).disabled).toBe(true);
  });

  it('中身の文字は文字として入る（HTML として読まない）。要素・配列も入る', () => {
    const b = ui.iconButton({ label: 'a', children: '<img src=x onerror=alert(1)>' });
    expect(b.querySelector('img')).toBeNull();
    expect(b.textContent).toBe('<img src=x onerror=alert(1)>');
    const span = document.createElement('span');
    const c = ui.iconButton({ label: 'a', children: ['x', span] });
    expect(c.textContent).toBe('x');
    expect(c.lastElementChild).toBe(span);
  });

  it('label が無い・文字でない・onClick が関数でない・中身が不正は invalid_argument', () => {
    invalidArg(() => ui.iconButton({ icon: 'settings' } as never));
    invalidArg(() => ui.iconButton({ label: '' }));
    invalidArg(() => ui.iconButton({ label: 1 } as never));
    invalidArg(() => ui.iconButton({ label: 'a', onClick: 'x' } as never));
    invalidArg(() => ui.iconButton({ label: 'a', children: 3 } as never));
    invalidArg(() => ui.iconButton(undefined as never));
  });
});

describe('ui.section', () => {
  it('見出しと中身（区切り線つき）', () => {
    const p = document.createElement('p');
    const s = ui.section({ title: '<b>通知</b>', class: 'x', children: p });
    expect(s.tagName).toBe('SECTION');
    expect(s.className).toBe('setting-section x');
    expect(s.querySelector('h2')?.textContent).toBe('<b>通知</b>');
    expect(s.querySelector('b')).toBeNull();
    expect(s.querySelector('hr.divider.setting-section-divider')).not.toBeNull();
    expect(s.lastElementChild).toBe(p);
    invalidArg(() => ui.section({} as never));
  });
});

describe('ui.statusLine', () => {
  it('kind・アイコン・busy・文字', () => {
    const a = ui.statusLine({ kind: 'ok', icon: 'puzzle', children: '最新です' });
    expect(a.tagName).toBe('P');
    expect(a.className).toBe('status-line status-line-ok');
    expect(a.textContent).toBe('最新です');
    expect(a.firstElementChild?.getAttribute('width')).toBe('15');
    expect(ui.statusLine().className).toBe('status-line');
    expect(ui.statusLine({ busy: true, icon: 'puzzle' }).firstElementChild?.getAttribute('class')).toContain('spin');
    expect(ui.statusLine({ children: '<i>x</i>' }).querySelector('i')).toBeNull();
    invalidArg(() => ui.statusLine({ kind: 'fancy' } as never));
  });
});

describe('ui.slider', () => {
  it('値・範囲・書き方・onInput（動く間）と onChange（離したとき）', () => {
    const log: string[] = [];
    const el = ui.slider({
      label: '音量',
      value: 10,
      max: 200,
      format: (v) => `${v}%`,
      onInput: (v) => log.push(`input ${v}`),
      onChange: (v) => log.push(`change ${v}`),
    });
    const input = el.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('音量');
    expect(el.querySelector('.slider-value')?.textContent).toBe('10%');
    input.value = '80';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    expect(log).toEqual(['input 80', 'change 80']);
    expect(el.querySelector('.slider-value')?.textContent).toBe('80%');
  });

  it('format が例外を投げても、数のまま出す。文字以外を返しても文字にする', () => {
    const a = ui.slider({ label: 'a', value: 5, format: () => { throw new Error('x'); } });
    expect(a.querySelector('.slider-value')?.textContent).toBe('5');
    const b = ui.slider({ label: 'a', value: 5, format: (() => 7) as never });
    expect(b.querySelector('.slider-value')?.textContent).toBe('7');
  });

  it('label が無い・数でない・関数でないは invalid_argument', () => {
    invalidArg(() => ui.slider({} as never));
    invalidArg(() => ui.slider({ label: 'a', value: 'x' } as never));
    invalidArg(() => ui.slider({ label: 'a', max: NaN }));
    invalidArg(() => ui.slider({ label: 'a', onInput: 1 } as never));
  });
});

describe('ui.menu', () => {
  const items = (onClick = vi.fn()) => [
    { text: '<b>コピー</b>', icon: 'puzzle', onClick },
    { text: '削除', danger: true },
    { text: '貼り付け', disabled: true, reason: '何もコピーしていません' },
  ];

  it('基準の要素の位置の入れ物の中に、メニューと幕が出る。文字は文字として入る', () => {
    const a = anchor();
    a.getBoundingClientRect = () => ({ left: 40, top: 20, width: 100, height: 30, right: 140, bottom: 50, x: 40, y: 20, toJSON() {} }) as DOMRect;
    const h = ui.menu({ anchor: a, items: items(), label: '操作' });
    const box = document.querySelector<HTMLElement>('.plugin-menu-anchor')!;
    expect(box.style.left).toBe('40px');
    expect(box.style.top).toBe('20px');
    expect(box.style.width).toBe('100px');
    expect(box.querySelector('.menu-backdrop')).not.toBeNull();
    const menu = box.querySelector('.menu')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('操作');
    const els = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')];
    expect(els).toHaveLength(3);
    expect(els[0].textContent).toBe('<b>コピー</b>');
    expect(els[0].querySelector('b')).toBeNull();
    expect(els[1].classList.contains('menu-item-danger')).toBe(true);
    expect(els[2].disabled).toBe(true);
    expect(els[2].querySelector('.menu-item-reason')?.textContent).toBe('何もコピーしていません');
    expect(h.closed).toBe(false);
  });

  it("align: 'end' は右端にそろえる入れ物", () => {
    ui.menu({ anchor: anchor(), items: items(), align: 'end' });
    expect(document.querySelector('.plugin-menu-anchor')!.classList.contains('plugin-menu-end')).toBe(true);
  });

  it('項目を選ぶと、先に閉じてから onClick を呼ぶ（onClose は呼ばない）', () => {
    const onClick = vi.fn(() => {
      expect(document.querySelector('.menu')).toBeNull();
    });
    const onClose = vi.fn();
    const h = ui.menu({ anchor: anchor(), items: items(onClick), onClose });
    document.querySelector<HTMLButtonElement>('.menu-item')!.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.plugin-menu-anchor')).toBeNull();
    expect(h.closed).toBe(true);
    expect(hostUi.pluginBack).toHaveLength(0);
  });

  it('幕の押下は閉じて onClose。close() は onClose を呼ばず、何度呼んでもよい', () => {
    const onClose = vi.fn();
    ui.menu({ anchor: anchor(), items: items(), onClose });
    document.querySelector<HTMLButtonElement>('.menu-backdrop')!.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('.plugin-menu-anchor')).toBeNull();

    const h = ui.menu({ anchor: anchor(), items: items(), onClose });
    h.close();
    h.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('.plugin-menu-anchor')).toBeNull();
    expect(hostUi.pluginBack).toHaveLength(0);
  });

  it('戻る操作で閉じて onClose。開いている間は戻る操作の層になる', () => {
    const onClose = vi.fn();
    ui.menu({ anchor: anchor(), items: items(), onClose });
    expect(hostUi.pluginBack).toHaveLength(1);
    expect(hostUi.back()).toBe(true);
    expect(document.querySelector('.plugin-menu-anchor')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(hostUi.pluginBack).toHaveLength(0);
  });

  it('不正な呼び方は invalid_argument（anchor・items・align・項目・関数）', () => {
    const a = anchor();
    invalidArg(() => ui.menu({ items: items() } as never));
    invalidArg(() => ui.menu({ anchor: 'x', items: items() } as never));
    invalidArg(() => ui.menu({ anchor: a, items: [] }));
    invalidArg(() => ui.menu({ anchor: a, items: 'x' } as never));
    invalidArg(() => ui.menu({ anchor: a, items: [{}] } as never));
    invalidArg(() => ui.menu({ anchor: a, items: [{ text: 1 }] } as never));
    invalidArg(() => ui.menu({ anchor: a, items: [{ text: 'a', onClick: 1 }] } as never));
    invalidArg(() => ui.menu({ anchor: a, items: items(), align: 'middle' } as never));
    invalidArg(() => ui.menu({ anchor: a, items: items(), onClose: 1 } as never));
    // 不正な呼び方では、何も残らない
    expect(document.querySelector('.plugin-menu-anchor')).toBeNull();
    expect(hostUi.pluginBack).toHaveLength(0);
  });
});

describe('ui.modal', () => {
  it('題名・本文・ボタン・幅。文字は文字として入る。フォーカスは最初のボタンへ', () => {
    const onClick = vi.fn();
    const h = ui.modal({
      title: '<i>確認</i>',
      width: 300,
      children: ['本文', document.createElement('hr')],
      actions: [{ text: 'OK', variant: 'primary', onClick }, { text: '閉じる' }],
    });
    const box = document.querySelector<HTMLElement>('.modal')!;
    expect(document.querySelector('.modal-scrim')).not.toBeNull();
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(box.style.getPropertyValue('--modal-w')).toBe('300px');
    expect(box.querySelector('.modal-title')?.textContent).toBe('<i>確認</i>');
    expect(box.querySelector('i')).toBeNull();
    const buttons = [...box.querySelectorAll<HTMLButtonElement>('.modal-actions .btn')];
    expect(buttons.map((b) => b.className)).toEqual(['btn primary', 'btn']);
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0].click();
    expect(onClick).toHaveBeenCalledOnce();
    // ボタンは自動では閉じない
    expect(h.closed).toBe(false);
    expect(document.querySelector('.modal')).not.toBeNull();
  });

  it('close() で閉じる（onClose は呼ばない・何度でも）。フォーカスは元に戻る', () => {
    const before = anchor();
    before.focus();
    const onClose = vi.fn();
    const h = ui.modal({ title: 't', onClose, actions: [{ text: 'a' }] });
    expect(document.activeElement).not.toBe(before);
    h.close();
    h.close();
    expect(document.querySelector('.modal')).toBeNull();
    expect(document.querySelector('.modal-scrim')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
    expect(hostUi.pluginBack).toHaveLength(0);
  });

  it('Esc・幕の押下は、閉じて onClose。閉じたあとの Esc は呼ばない', () => {
    const onClose = vi.fn();
    ui.modal({ title: 't', onClose });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('.modal')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();

    ui.modal({ title: 't', onClose });
    document.querySelector<HTMLElement>('.modal-scrim')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('onClose が無くても、Esc・幕で閉じる', () => {
    ui.modal({ title: 't' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.modal')).toBeNull();
  });

  it('戻る操作で閉じて onClose。ほかの層（メニュー）は新しいものから順に閉じる', () => {
    const onModal = vi.fn();
    const onMenu = vi.fn();
    ui.modal({ title: 't', onClose: onModal });
    ui.menu({ anchor: anchor(), items: [{ text: 'a' }], onClose: onMenu });
    expect(hostUi.pluginBack).toHaveLength(2);
    hostUi.back();
    expect(onMenu).toHaveBeenCalledOnce();
    expect(onModal).not.toHaveBeenCalled();
    expect(document.querySelector('.modal')).not.toBeNull();
    hostUi.back();
    expect(onModal).toHaveBeenCalledOnce();
    expect(document.querySelector('.modal')).toBeNull();
    expect(hostUi.back()).toBe(false);
  });

  it('onClose の中で close() を呼んでも、二重には閉じない', () => {
    let h!: Disnans.UiOverlay;
    const onClose = vi.fn(() => h.close());
    h = ui.modal({ title: 't', onClose });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('不正な呼び方は invalid_argument。アクションのボタンの誤りも（何も残らない）', () => {
    invalidArg(() => ui.modal({} as never));
    invalidArg(() => ui.modal({ title: 1 } as never));
    invalidArg(() => ui.modal({ title: 't', width: 'x' } as never));
    invalidArg(() => ui.modal({ title: 't', children: 3 } as never));
    invalidArg(() => ui.modal({ title: 't', actions: 'x' } as never));
    invalidArg(() => ui.modal({ title: 't', actions: [{ icon: 'puzzle' } as never] }));
    invalidArg(() => ui.modal({ title: 't', onClose: 1 } as never));
    expect(document.querySelector('.modal')).toBeNull();
    expect(hostUi.pluginBack).toHaveLength(0);
  });
});

describe('プラグインを外すとき', () => {
  it('closePluginOverlays は、開いているメニューもモーダルも閉じる（onClose は呼ばず、戻る操作の層も外す）', () => {
    const onClose = vi.fn();
    ui.modal({ title: 't', onClose });
    ui.menu({ anchor: anchor(), items: [{ text: 'a' }], onClose });
    expect(hostUi.pluginBack).toHaveLength(2);
    closePluginOverlays();
    expect(document.querySelector('.modal, .menu, .plugin-menu-anchor')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(hostUi.pluginBack).toHaveLength(0);
    closePluginOverlays();
  });

  it('this.register(overlay.close) の形でも使える（close は this に依らない）', () => {
    const h = ui.modal({ title: 't' });
    const cleanup = h.close;
    cleanup();
    expect(document.querySelector('.modal')).toBeNull();
    expect(h.closed).toBe(true);
  });

  it('PluginHost が外す（unload）と、開いたままのものが閉じる', async () => {
    // ホストの実物の ui（lib/plugins/ui.ts の createUi）ではなく、同じモジュールの closePluginOverlays を、unload が呼ぶことを見る
    vi.resetModules();
    vi.doMock('../call/instance.svelte', () => ({ callApi: {} }));
    const { PluginHost } = await import('./host.svelte');
    const ui2 = (await import('./ui')).createUi({ toast: vi.fn(), confirm: async () => true });
    ui2.modal({ title: 't' });
    ui2.menu({ anchor: anchor(), items: [{ text: 'a' }] });
    const host = new PluginHost();
    const stop = vi.fn();
    (host as unknown as { loaded: Map<string, unknown> }).loaded.set('p', { runtime: { stop }, style: null });
    (host as unknown as { unload(id: string): void }).unload('p');
    expect(stop).toHaveBeenCalledOnce();
    expect(document.querySelector('.modal, .menu, .plugin-menu-anchor')).toBeNull();
    vi.doUnmock('../call/instance.svelte');
  });
});
