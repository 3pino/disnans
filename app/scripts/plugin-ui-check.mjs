#!/usr/bin/env node
// プラグイン向けの disnans.ui（本体の Svelte の部品を mount して DOM の要素を渡すもの）を、実物の Chromium・実物の CSS・実物の入力で確かめる。
// 見る: 押す（実際の押下）が効く／メニューが基準の要素の下に開き、画面の端では収まる／モーダルの位置・フォーカス・Esc・幕／設定の行の配置。
// 見た目の良し悪しは見ない（スクリーンショットなし）。vite を自分で立て、Chromium を起動し、終わったら両方止める。
// 使い方: cd app && node scripts/plugin-ui-check.mjs   （CHROME で Chromium を指定できる）
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { fixtureScript } from './touch-fixture.mjs';
import { connectCdp, launchChrome, makeProfile, openPage, stopChrome } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeProfile('disnans-plugin-ui-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let chrome, ws;
try {
  await vite.listen();
  const APP = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  const launched = launchChrome(profile);
  chrome = launched.child;
  ws = await connectCdp(await launched.endpoint);
  const S = await openPage(ws);
  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const click = async (x, y) => {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const press = async (key, code, vk) => {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(150);
  };
  const center = (selector, text = '') =>
    evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!e)return null;const r=e.getBoundingClientRect();return[r.x+r.width/2,r.y+r.height/2];})()`);
  const rect = (selector) =>
    evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};})()`);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript({ server: 'http://127.0.0.1:1', platform: 'linux' }) });
  await S('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url: APP });
  for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.nav-bar-side')`)); i++) await sleep(100);
  await sleep(500);

  // ページの中で、本体の disnans.ui（lib/plugins/ui.ts。本体が使っているのと同じモジュール）を使う
  await evaluate(`(async () => {
    const { createUi } = await import('/src/lib/plugins/ui.ts');
    const log = (window.__log = []);
    window.__ui = createUi({ toast: () => {}, confirm: async () => true, onBack: () => () => {} });
    const stage = document.createElement('div');
    stage.id = 'stage';
    stage.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none';
    document.body.append(stage);
    window.__stage = stage;
    window.__place = (el, left, top) => { el.style.cssText += ';position:fixed;pointer-events:auto;left:' + left + 'px;top:' + top + 'px'; stage.append(el); return el; };
    return true;
  })()`);

  // 1. 押す（実際の押下）が効く・トグルは見た目も切り替わる
  await evaluate(`(() => {
    const { __ui: ui, __place: place, __log: log } = window;
    const b = place(ui.button({ text: '押す', variant: 'primary', onClick: () => log.push('button') }), 200, 100); b.id = 'b1';
    const t = place(ui.toggle({ value: false, label: 't', onChange: (v) => log.push('toggle ' + v) }), 400, 100); t.id = 't1';
    return true;
  })()`);
  await click(...(await center('#b1')));
  await click(...(await center('#t1')));
  assert.deepEqual(await evaluate('window.__log'), ['button', 'toggle true']);
  assert(await evaluate(`document.querySelector('#t1').classList.contains('toggle-on') && document.querySelector('#t1').getAttribute('aria-checked') === 'true'`), 'toggle did not switch');
  console.log('ok  real clicks reach the plugin callbacks and the toggle switches');

  // 2. メニュー: 基準の要素の下に開く（左そろえ・右そろえ）、下の端では上へ
  const openMenu = (id, align = 'start') =>
    evaluate(`(() => { const { __ui: ui, __log: log } = window; const a = document.querySelector('#${id}'); window.__menu = ui.menu({ anchor: a, align: '${align}', items: [{ text: 'コピー', onClick: () => log.push('copy') }, { text: '削除', danger: true, onClick: () => log.push('del') }], onClose: () => log.push('menu-closed') }); return true; })()`);
  await evaluate(`(() => { const { __ui: ui, __place: place } = window; const a = place(ui.button({ text: '上' }), 300, 200); a.id = 'a1'; const e = place(ui.button({ text: '右' }), 700, 200); e.id = 'a2'; const d = place(ui.button({ text: '下' }), 300, 650); d.id = 'a3'; const r = place(ui.button({ text: '端' }), 940, 200); r.id = 'a4'; return true; })()`);
  const near = (a, b, msg) => assert(Math.abs(a - b) <= 1.5, `${msg}: ${a} vs ${b}`);

  await openMenu('a1');
  let a = await rect('#a1'), m = await rect('.plugin-menu-anchor .menu');
  near(m.left, a.left, 'menu left = anchor left');
  near(m.top, a.bottom + 6, 'menu top = anchor bottom + 6');
  assert(await evaluate(`(() => { const i = document.querySelector('.plugin-menu-anchor .menu-item'); const r = i.getBoundingClientRect(); return i.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)); })()`), 'menu item is covered');
  await click(...(await center('.plugin-menu-anchor .menu-item', 'コピー')));
  assert.deepEqual((await evaluate('window.__log')).slice(-1), ['copy']);
  assert.equal(await rect('.plugin-menu-anchor'), null, 'menu stays after picking an item');

  await openMenu('a2', 'end');
  a = await rect('#a2'); m = await rect('.plugin-menu-anchor .menu');
  near(m.right, a.right, "align 'end': menu right = anchor right");
  await click(100, 400); // 幕（外側）
  assert.deepEqual((await evaluate('window.__log')).slice(-1), ['menu-closed']);
  assert.equal(await rect('.plugin-menu-anchor'), null, 'menu stays after pressing the backdrop');

  await openMenu('a3');
  a = await rect('#a3'); m = await rect('.plugin-menu-anchor .menu');
  assert(m.bottom <= a.top + 0.5 && m.top >= 0, `bottom edge: menu should open above the anchor ${JSON.stringify({ a, m })}`);
  await evaluate('window.__menu.close()');

  await openMenu('a4');
  m = await rect('.plugin-menu-anchor .menu');
  assert(m.right <= 1000 - 7.5 && m.left >= 0, `right edge: menu should stay inside the screen ${JSON.stringify(m)}`);
  await evaluate('window.__menu.close()');
  console.log('ok  menu opens below the anchor (start / end aligned), flips above at the bottom edge, stays inside at the right edge; item pick and backdrop close it');

  // 3. モーダル: 画面の中・最初のボタンにフォーカス・Esc / 幕 / close
  await evaluate(`(() => { const { __ui: ui, __log: log } = window; window.__modal = ui.modal({ title: '確認', children: '本文', actions: [{ text: 'OK', variant: 'primary', onClick: () => log.push('ok') }, { text: '閉じる' }], onClose: () => log.push('modal-closed') }); return true; })()`);
  const box = await rect('.modal');
  assert(box && box.left >= 0 && box.right <= 1000 && box.top >= 0 && box.bottom <= 700, `modal outside the screen ${JSON.stringify(box)}`);
  assert(await evaluate(`document.activeElement?.textContent === 'OK'`), 'first button is not focused');
  await click(...(await center('.modal .btn.primary')));
  assert.deepEqual((await evaluate('window.__log')).slice(-1), ['ok']);
  assert(await evaluate(`!!document.querySelector('.modal')`), 'modal must stay open after an action button');
  await press('Escape', 'Escape', 27);
  assert.deepEqual((await evaluate('window.__log')).slice(-1), ['modal-closed']);
  assert.equal(await rect('.modal'), null, 'modal stays after Esc');
  await evaluate(`(() => { window.__modal = window.__ui.modal({ title: 't', onClose: () => window.__log.push('scrim') }); return true; })()`);
  await click(20, 20);
  assert.deepEqual((await evaluate('window.__log')).slice(-1), ['scrim']);
  console.log('ok  modal is inside the screen, focuses the first button, closes with Esc and the backdrop (onClose), action buttons do not close it');

  // 4. 設定の行: 操作の包み（setting-row-control-slot）があり、行の高さ・操作の縦位置を測る（旧 DOM 版 = 包みなし との差を表示）
  const geo = await evaluate(`(() => {
    const { __ui: ui, __place: place } = window;
    const box = place(document.createElement('div'), 100, 300); box.style.width = '420px'; box.className = 'scroll';
    const t = ui.toggle({ value: true, label: 'x' });
    const row = ui.setting(box, { name: '音を鳴らす', description: '説明', icon: 'bell', control: t });
    // 旧 DOM 版と同じ形（操作の包みなし）を手で作る
    const old = document.createElement('div'); old.className = 'setting-row';
    old.innerHTML = '<div class="setting-row-info"><div class="setting-row-name">音を鳴らす</div><div class="setting-row-description">説明</div></div><div class="setting-row-control"><button type="button" class="toggle toggle-on" role="switch" aria-checked="true"></button></div>';
    box.append(old);
    const r = (e) => e.getBoundingClientRect();
    const mid = (e) => { const b = r(e); return b.top + b.height / 2; };
    const oldT = old.querySelector('.toggle');
    return {
      slot: !!row.querySelector('.setting-row-control > .setting-row-control-slot > .toggle'),
      rowH: r(row).height, oldRowH: r(old).height,
      newOffset: mid(t) - mid(row), oldOffset: mid(oldT) - mid(old),
    };
  })()`);
  assert(geo.slot, 'control slot wrapper missing');
  assert(Math.abs(geo.rowH - geo.oldRowH) <= 0.5, `row height changed ${JSON.stringify(geo)}`);
  console.log(`ok  setting row: height ${geo.rowH.toFixed(1)}px (same as before); toggle vertical offset from the row centre: ${geo.newOffset.toFixed(2)}px now vs ${geo.oldOffset.toFixed(2)}px before the wrapper (shift ${(geo.newOffset - geo.oldOffset).toFixed(2)}px)`);

  console.log('plugin ui: real clicks, menu / modal placement and closing, setting row layout (no appearance check)');
} finally {
  ws?.close();
  stopChrome(chrome, profile);
  await vite.close();
}
