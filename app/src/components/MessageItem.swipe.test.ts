// @vitest-environment jsdom
// 左へのスワイプで返信する操作と、画像の横並びの行（横スクロール）の競合。
// 行が右の端まで動くまでは行のスクロールに譲り、端に着いてからさらに左へ動いたときだけ返信にする。
// 実際の指のスクロールは Chromium でも再現できないので、行の寸法（scrollLeft など）を決めて、タッチの事件を直接送る。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageItem from './MessageItem.svelte';
import { reply } from '../lib/stores/reply.svelte';
import { ui } from '../lib/stores/ui.svelte';
import type { Message } from '../lib/protocol/Message';

const message = {
  id: 'm1',
  author_id: 'u1',
  reply_to: null,
  reply_preview: null,
  body: 'x',
  attachments: [],
  reactions: [],
  created_at: 1,
  edited_at: null,
  card: null,
  bot: null,
} as unknown as Message;

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  reply.clear();
  ui.editing = null;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(MessageItem, { target, props: { message } });
  flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  reply.clear();
});

type Pt = { x: number; y: number };
function touchEv(type: string, touches: Pt[], changed: Pt[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = (p: Pt) => ({ identifier: 1, clientX: p.x, clientY: p.y });
  Object.defineProperty(ev, 'touches', { value: touches.map(t) });
  Object.defineProperty(ev, 'changedTouches', { value: changed.map(t) });
  return ev;
}

/** 本文の中に、横スクロールの行を置く（寸法は、あふれた行: 幅 300・中身 900。scrollLeft は state で動かす） */
function addRow(cls: string, state: { scrollLeft: number }, overflow = true): HTMLElement {
  const row = document.createElement('div');
  row.className = cls;
  const child = document.createElement('span');
  row.appendChild(child);
  Object.defineProperty(row, 'clientWidth', { value: 300 });
  Object.defineProperty(row, 'scrollWidth', { value: overflow ? 900 : 300 });
  Object.defineProperty(row, 'scrollLeft', { get: () => state.scrollLeft });
  target!.querySelector('.message-item')!.appendChild(row);
  return child;
}

/** 開始点から、x 座標を順に動かす（y は同じ）。指を離すところまで */
function drag(el: Element, xs: number[], opts: { scroll?: (x: number) => void } = {}): void {
  const y = 100;
  el.dispatchEvent(touchEv('touchstart', [{ x: xs[0], y }], [{ x: xs[0], y }]));
  for (const x of xs.slice(1)) {
    opts.scroll?.(x);
    el.dispatchEvent(touchEv('touchmove', [{ x, y }], [{ x, y }]));
  }
  const last = xs[xs.length - 1];
  el.dispatchEvent(touchEv('touchend', [], [{ x: last, y }]));
  flushSync();
}

describe('左へのスワイプで返信（行の外）', () => {
  it('行の外では、これまでどおり左へ 60px 以上動かして離すと返信する', () => {
    drag(target!.querySelector('.message-item')!, [300, 280, 240, 200]);
    expect(reply.get()?.id).toBe('m1');
  });
});

describe('画像の横並びの行の上でのスワイプ', () => {
  for (const cls of ['embed-row', 'attachment-images']) {
    describe(cls, () => {
      it('右の端に着いていない間は、左へ大きく動かしても返信しない（行のスクロールに譲る）', () => {
        const state = { scrollLeft: 0 };
        const el = addRow(cls, state);
        drag(el, [300, 250, 200, 150, 100], { scroll: (x) => (state.scrollLeft = 300 - x) });
        expect(state.scrollLeft).toBeLessThan(600); // まだ端（600）ではない
        expect(reply.get()).toBeNull();
      });

      it('端まで動かしたあとの動きだけを数える（スクロールで 300px 動かし、端に着いてから 30px では返信しない）', () => {
        const state = { scrollLeft: 0 };
        const el = addRow(cls, state);
        // x=300→0 のあいだに scrollLeft が 0→600（端）に着き、その後の x=0→-30 が端に着いてからの動き
        drag(el, [300, 200, 100, 0, -15, -30], { scroll: (x) => (state.scrollLeft = Math.min(600, (300 - x) * 2)) });
        expect(reply.get()).toBeNull();
      });

      it('端に着いたあと、さらに 60px 以上左へ動かして離すと返信する', () => {
        const state = { scrollLeft: 0 };
        const el = addRow(cls, state);
        // x=300→150 のあいだに端（600）に着き（scrollLeft = (300-x)*4）、そこからさらに左へ 90px
        drag(el, [300, 250, 200, 150, 120, 90, 60], { scroll: (x) => (state.scrollLeft = Math.min(600, (300 - x) * 4)) });
        expect(state.scrollLeft).toBe(600);
        expect(reply.get()?.id).toBe('m1');
      });

      it('途中の位置で、scrollLeft がまだ変わらなくても（スクロールの反映待ち）、端でなければ返信しない', () => {
        const state = { scrollLeft: 100 };
        const el = addRow(cls, state);
        drag(el, [300, 250, 200, 150, 100]);
        expect(reply.get()).toBeNull();
      });

      it('すでに右の端にある行では、最初から左への動きで返信する', () => {
        const state = { scrollLeft: 600 };
        const el = addRow(cls, state);
        drag(el, [300, 270, 230, 200]);
        expect(reply.get()?.id).toBe('m1');
      });

      it('あふれていない行（スクロールしない）では、ふつうに返信する', () => {
        const state = { scrollLeft: 0 };
        const el = addRow(cls, state, false);
        drag(el, [300, 270, 230, 200]);
        expect(reply.get()?.id).toBe('m1');
      });

      it('端にあっても、右へ動かして（戻して）離しても返信しない', () => {
        const state = { scrollLeft: 600 };
        const el = addRow(cls, state);
        drag(el, [100, 150, 200, 300], { scroll: (x) => (state.scrollLeft = 600 - (x - 100)) });
        expect(reply.get()).toBeNull();
      });
    });
  }
});
