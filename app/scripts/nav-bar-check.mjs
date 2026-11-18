#!/usr/bin/env node
// 回帰の検査（モバイル・DOM だけで）: コアの「ファイル」（fixplor の view）を開いても、ナビバー（#nav-bar）は画面の下に出たままで、
// パネルはその上に収まること。ページの中へストアを import しない（画面の見えるものだけを読む）。
// 使い方（先に npm run dev）: CHROME_BIN=<chromium> DISNANS_URL=http://127.0.0.1:5173 node scripts/nav-bar-check.mjs
// 起動したプロセス（Chromium と仮のサーバー）だけを止める。終了コードは 0（全部通った）か 1。
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureScript } from './touch-fixture.mjs';

const CHROME = process.env.CHROME_BIN;
const APP = process.env.DISNANS_URL;
if (!CHROME || !APP) {
  console.error('CHROME_BIN と DISNANS_URL を指定してください');
  process.exit(2);
}
void dirname(fileURLToPath(import.meta.url));

// 仮のサーバー（共有フォルダの一覧・hello 用の REST。touch-check と同じ形）
const now = Date.now();
const entry = (path, kind, size = 0, mime = null) => ({ name: path.split('/').pop(), path, kind, size, modified: now - 6e4, mime, message_id: null, file_id: null });
const items = [entry('docs', 'dir'), entry('a.txt', 'file', 12, 'text/plain')];
const fake = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  for await (const _ of req) void _;
  const path = new URL(req.url, 'http://x').pathname;
  const body = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (path === '/api/shared') return body(items);
  if (path === '/api/shared-trash') return body([]);
  if (path === '/api/shared-size') return body({ used: 0, total: null });
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'disnans-navbar-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  fake.close();
  rmSync(profile, { recursive: true, force: true });
};

let failed = 0;
try {
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    chrome.on('exit', (c) => reject(new Error(`Chromium が終了しました（${c}）`)));
    setTimeout(() => reject(new Error('Chromium の起動を待ち切れませんでした')), 20000);
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const S = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++seq;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evaluate = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  };
  const waitFor = async (expression, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`待ち切れませんでした: ${label}`);
  };

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript({ server: FAKE, platform: 'linux' }) });
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await S('Page.navigate', { url: APP + '/' });
  // 起動（チャットの画面が出て、ナビバーがある）
  await waitFor(`document.querySelector('#nav-bar')`, 15000, 'ナビバー');
  // コアの「ファイル」の項目（ナビの「ファイル」の一つ。内蔵は隠れる）が出るまで
  await waitFor(`[...document.querySelectorAll('#nav-bar button')].some((b) => b.textContent.includes('ファイル'))`, 20000, 'ナビの「ファイル」');
  await sleep(300);

  // 画面の幾何（DOM だけ）
  const geo = () => evaluate(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, w: b.width }; };
    const nav = document.querySelector('#nav-bar');
    const panel = document.querySelector('.shell-panel');
    const navBtn = [...nav.querySelectorAll('button')].find((b) => b.textContent.includes('ファイル'));
    const c = r(nav);
    const at = document.elementFromPoint(c.left + c.w / 2, c.top + c.h / 2);
    return {
      vh: window.innerHeight, vw: window.innerWidth,
      nav: r(nav), navVisible: getComputedStyle(nav).display !== 'none' && c.h > 0,
      navHit: !!at && nav.contains(at),
      panel: panel ? r(panel) : null,
      panelClass: panel ? panel.className : null,
      selected: [...nav.querySelectorAll('button[aria-current="page"]')].map((b) => b.textContent.trim()),
      hasNavBtn: !!navBtn,
    };
  })()`);
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (e) {
      failed++;
      console.log(`NG  ${name}\n    ${e.message}`);
    }
  };
  const navAtBottom = (g, where) => {
    assert.ok(g.navVisible, `${where}: ナビバーが見えない`);
    assert.ok(Math.abs(g.nav.bottom - g.vh) < 2, `${where}: ナビバーが下に来ていない（bottom ${g.nav.bottom} / 画面 ${g.vh}）`);
    assert.ok(g.navHit, `${where}: ナビバーの中央を別のものが覆っている`);
  };
  const panelAboveNav = (g, where) => {
    assert.ok(g.panel, `${where}: パネルがない`);
    assert.ok(g.panel.bottom <= g.nav.top + 1, `${where}: パネルがナビバーに重なる（panel.bottom ${g.panel.bottom} > nav.top ${g.nav.top}）`);
  };

  await check('起動直後（チャット）: ナビバーが画面の下にあり、覆われていない', async () => navAtBottom(await geo(), 'チャット'));

  await check('コアの「ファイル」を開く（ナビの項目を押す）: ナビは下のまま、パネルはナビの上に収まる', async () => {
    await evaluate(`(() => { const b = [...document.querySelectorAll('#nav-bar button')].find((x) => x.textContent.includes('ファイル')); b.click(); return true; })()`);
    await waitFor(`document.querySelector('.shell-panel.shell-panel-files')`, 8000, 'コアの「ファイル」の枠');
    await sleep(400);
    const g = await geo();
    navAtBottom(g, 'ファイル');
    panelAboveNav(g, 'ファイル');
    assert.ok(g.selected.some((t) => t.includes('ファイル')), `選ばれている項目がファイルではない: ${g.selected.join(' / ')}`);
  });

  await check('開いたまま戻る（ナビの「チャット」）→ もう一度「ファイル」: 毎回ナビは下', async () => {
    await evaluate(`(() => { const b = [...document.querySelectorAll('#nav-bar button')].find((x) => x.textContent.includes('チャット')); b?.click(); return !!b; })()`);
    await sleep(400);
    navAtBottom(await geo(), 'チャットへ戻った後');
    await evaluate(`(() => { const b = [...document.querySelectorAll('#nav-bar button')].find((x) => x.textContent.includes('ファイル')); b.click(); return true; })()`);
    await waitFor(`document.querySelector('.shell-panel.shell-panel-files')`, 8000, '開き直し');
    await sleep(300);
    const g = await geo();
    navAtBottom(g, '開き直し');
    panelAboveNav(g, '開き直し');
  });

  await check('広い画面（デスクトップ）: ナビは左に残り、「ファイル」の枠は右側で重ならない', async () => {
    await S('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    await S('Emulation.setTouchEmulationEnabled', { enabled: false });
    await sleep(500);
    const g = await geo();
    assert.ok(g.nav.left < 4, `ナビバーが左にない（left ${g.nav.left}）`);
    if (g.panel) assert.ok(g.nav.right <= g.panel.left + 1, `ナビバーとパネルが重なる（nav.right ${g.nav.right} > panel.left ${g.panel.left}）`);
  });

  console.log(failed === 0 ? '全部通りました' : `${failed} 件が失敗しました`);
} catch (e) {
  failed++;
  console.error(`失敗: ${e.message}`);
} finally {
  cleanup();
}
process.exit(failed === 0 ? 0 : 1);
