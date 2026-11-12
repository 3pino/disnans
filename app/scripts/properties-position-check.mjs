#!/usr/bin/env node
// 広い画面で、共有フォルダの項目の「…」メニュー（プロパティ）が、左のナビバーに隠れず、シェルの中（ナビバーの右）に収まるかを、
// 実物の画面の矩形で確かめる。見た目の良し悪しは見ない（スクリーンショットなし）。
// vite を自分で立て、Chromium を起動し、終わったら両方止める。touch-fixture.mjs で Tauri の IPC 境界だけを差し込む。
// 使い方: cd app && node scripts/properties-position-check.mjs   （CHROME で Chromium を指定できる）
import assert from 'node:assert/strict';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { fixtureScript } from './touch-fixture.mjs';
import { connectCdp, launchChrome, makeProfile, openPage, stopChrome } from './cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeProfile('disnans-properties-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 仮の共有フォルダ（直下に 6 つ。グリッドで左端の列に項目が来る）
const now = Date.now();
const entries = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'].map((name) => ({ name, path: name, kind: 'file', size: 10, modified: now - 6e4, mime: 'text/plain', message_id: null, file_id: null }));
const fake = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && (path === '/api/shared' || path === '/api/shared/')) return void res.end(JSON.stringify({ path: '', entries }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

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
    await sleep(200);
  };
  const press = async (key, code, vk) => {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  const centerOf = (selector, text = '') => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!e)return null;const r=e.getBoundingClientRect();return[r.x+r.width/2,r.y+r.height/2];})()`);
  const rectOf = (selector) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom};})()`);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript({ server: FAKE, platform: 'linux' }) });

  const VIEW_GRID = 'アイコン';

  /** 幅 width の広い画面（デスクトップ）で、共有フォルダを開き、view（details か grid）の left 番目の項目の「…」からプロパティを開く */
  async function openFromLeftEdge(width, view) {
    await S('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
    await S('Page.navigate', { url: APP });
    for (let i = 0; i < 60 && !(await evaluate(`!!document.querySelector('.nav-bar-side')`)); i++) await sleep(100);
    assert(await evaluate(`!!document.querySelector('.nav-bar-side')`), `wide layout (nav-bar-side) missing at width ${width}`);
    await sleep(500);
    await press('F2', 'F2', 113);
    await sleep(400);
    await S('Input.insertText', { text: '共有フォルダを開く' });
    await sleep(300);
    await press('Enter', 'Enter', 13);
    for (let i = 0; i < 60 && !(await evaluate(`document.querySelectorAll('.file-explorer-item').length>=6`)); i++) await sleep(100);
    assert(await evaluate(`document.querySelectorAll('.file-explorer-item').length>=6`), 'explorer entries not shown');
    if (view === 'grid') {
      await click(...(await centerOf('button[aria-label="メニュー"]')));
      await click(...(await centerOf('.menu-item', VIEW_GRID)));
      await sleep(300);
    }
    // 左端の項目（一覧の最初）の「…」を押す
    const first = await centerOf('.file-explorer-item .shared-entry-menu-button');
    assert(first, 'entry menu button missing');
    await click(...first);
    assert(await evaluate(`!!document.querySelector('.shared-entry-menu')`), 'entry menu did not open');
  }

  /** メニューと周りの矩形を測る */
  const measure = () => evaluate(`(()=>{
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
    const menu = document.querySelector('.shared-entry-menu');
    const item = menu?.querySelector('.menu-item');
    const ib = item?.getBoundingClientRect();
    const hit = ib ? document.elementFromPoint(ib.x + ib.width / 2, ib.y + ib.height / 2) : null;
    return { menu: r(menu), nav: r(document.querySelector('.nav-bar-side')), shell: r(document.querySelector('.shell')), itemHit: !!item && !!hit && item.contains(hit), vw: innerWidth };
  })()`);

  for (const view of ['details', 'grid']) {
    for (const width of [1280, 800]) {
      await openFromLeftEdge(width, view);
      const m = await measure();
      const tag = `${view}/${width}px ${JSON.stringify(m)}`;
      assert(m.menu && m.nav && m.shell, `rects missing ${tag}`);
      assert(m.menu.left >= m.nav.right - 0.5, `menu overlaps the nav-bar ${tag}`);
      assert(m.menu.left >= m.shell.left - 0.5 && m.menu.right <= m.shell.right + 0.5 && m.menu.top >= m.shell.top - 0.5 && m.menu.bottom <= m.shell.bottom + 0.5, `menu is outside the shell ${tag}`);
      assert(m.itemHit, `プロパティ item is covered by something else ${tag}`);
      // プロパティを開く: ダイアログの本体はシェルの中にあり、ナビバーと交わらない（スクリムは画面全体のまま）
      await click(...(await centerOf('.shared-entry-menu .menu-item', 'プロパティ')));
      assert(await evaluate(`!!document.querySelector('.modal')`), `properties dialog did not open ${tag}`);
      const d = await rectOf('.modal');
      assert(d.left >= m.nav.right - 0.5 && d.right <= m.shell.right + 0.5 && d.top >= m.shell.top - 0.5 && d.bottom <= m.shell.bottom + 0.5, `dialog is not inside the shell content area ${tag} dialog=${JSON.stringify(d)}`);
      console.log(`ok  ${view}/${width}px: menu left ${m.menu.left.toFixed(1)} >= nav right ${m.nav.right.toFixed(1)}, dialog inside shell content`);
    }
  }
  console.log('properties position: menu and dialog stay inside the shell content area (right of the nav-bar) on wide screens (no appearance check)');
} finally {
  ws?.close();
  stopChrome(chrome, profile);
  fake.close();
  await vite.close();
}
