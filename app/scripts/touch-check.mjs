#!/usr/bin/env node
// 実物の画面で、共有フォルダの「≡」メニューと項目の「…」メニューが、タッチで押せるかを確かめる（batch11）。
// vitest の外で動く（Chromium が要る）。使い方:
//   1) 別の端末で `npm run dev`（例: http://127.0.0.1:5173）
//   2) CHROME_BIN=<chromium か headless_shell のパス> DISNANS_URL=http://127.0.0.1:5173 node scripts/touch-check.mjs
// 共有フォルダの一覧は、このスクリプトが立てる仮のサーバーから読む（本物のサーバーは要らない）。
// 起動したプロセス（Chromium と仮のサーバー）だけを止める。終了コードは 0（全部押せた）か 1。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN;
const APP = process.env.DISNANS_URL;
if (!CHROME || !APP) {
  console.error('CHROME_BIN と DISNANS_URL を指定してください');
  process.exit(2);
}

// ---- 仮のサーバー（/api/shared の一覧だけ） ----
const now = Date.now();
const LISTING = {
  '': [
    { name: 'docs', path: 'docs', kind: 'dir', size: 0, modified: now - 3e5, mime: null, message_id: null, file_id: null },
    { name: 'a.txt', path: 'a.txt', kind: 'file', size: 12, modified: now - 6e4, mime: 'text/plain', message_id: null, file_id: null },
    { name: 'pic.png', path: 'pic.png', kind: 'file', size: 2048, modified: now - 9e5, mime: 'image/png', message_id: null, file_id: null },
  ],
  docs: [{ name: 'memo.md', path: 'docs/memo.md', kind: 'file', size: 5, modified: now, mime: 'text/markdown', message_id: null, file_id: null }],
};
const fake = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/api\/shared\/?/, '').replace(/\/$/, '');
  if (req.url?.startsWith('/api/shared') && LISTING[rel]) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: rel, entries: LISTING[rel] }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;

// ---- Chromium（一時のプロファイル。終わったら消す） ----
const profile = mkdtempSync(join(tmpdir(), 'disnans-touch-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  chrome.kill();
  fake.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 一時の場所 */ }
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpVersion() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chromium に繋がりません');
}

const ver = await cdpVersion();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const id = ++seq;
    waiting.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (method, params) => send(method, params, sessionId);
const evalJs = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`評価に失敗: ${expr.slice(0, 60)}`);
  return r.result?.result?.value;
};
async function tap(x, y) {
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
}

await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// 仮のサーバーへ向け、本人の名前を入れて、設定の画面を飛ばす
await S('Page.navigate', { url: APP + '/robots.txt' });
await sleep(800);
await evalJs(`localStorage.setItem('disnans.server', ${JSON.stringify(FAKE)}); localStorage.removeItem('disnans.explorer.view'); localStorage.removeItem('disnans.explorer.sort'); sessionStorage.setItem('disnans.devUser', 'touch-check'); 1`);
await S('Page.navigate', { url: APP + '/' });
await sleep(2500);

// 共有フォルダを、コマンドパレット（F2）から開く
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
await sleep(400);
await S('Input.insertText', { text: '共有フォルダを開く' });
await sleep(300);
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(900);
if (!(await evalJs(`!!document.querySelector('.shell-panel-files')`))) {
  console.error('共有フォルダの画面が開けませんでした');
  process.exit(1);
}

const failures = [];
const expect = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}`);
  if (!ok) failures.push(label);
};
const hitIsInside = (sel, text) =>
  evalJs(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!b) return 'missing'; const r=b.getBoundingClientRect(); const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return b.contains(t)?'ok':'covered'})()`);
const centerOf = (sel, text) =>
  evalJs(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!b) return null; const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
const closeToasts = () => evalJs(`[...document.querySelectorAll('.toast-close')].forEach(b=>b.click()), 1`).then(() => sleep(120));
async function openMainMenu() {
  await closeToasts();
  const p = await evalJs(`(()=>{const r=document.querySelector('button[aria-label="メニュー"]').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  await tap(p[0], p[1]);
  await sleep(120);
}
/** メニューの項目を、タッチで押す（押せる位置か、押した結果も確かめる） */
async function pressItem(label, text) {
  const hit = await hitIsInside('.file-explorer-menu .menu-item', text);
  expect(`${label}「${text}」が押せる（上に何も被らない）`, hit === 'ok');
  if (hit !== 'ok') return false;
  const p = await centerOf('.file-explorer-menu .menu-item', text);
  await tap(p[0], p[1]);
  await sleep(250);
  return true;
}

/** 一覧の名前の並び（フォルダ → 項目の順）。並べ方の確認に使う */
const namesAre = (want) => evalJs(`[...document.querySelectorAll('.file-explorer-item .file-explorer-name')].map(x=>x.textContent).join(',') === ${JSON.stringify(want)}`);

const MAIN_ITEMS = [
  ['アップロード', 'アップロード', () => evalJs(`!document.querySelector('.file-explorer-menu')`)],
  ['新しいフォルダ', '新しいフォルダ', () => evalJs(`!!document.querySelector('.file-explorer-mkdir')`)],
  ['選択モード', '選択モード', () => evalJs(`!!document.querySelector('.file-explorer-selection')`)],
  ['表示: 詳細', '詳細', () => evalJs(`!!document.querySelector('.file-explorer-columns')`)],
  ['表示: アイコン', 'アイコン', () => evalJs(`!!document.querySelector('.file-explorer-view-grid')`)],
  ['表示: 一覧', '一覧', () => evalJs(`!document.querySelector('.file-explorer-view-grid') && !document.querySelector('.file-explorer-columns')`)],
  ['並び替え: 更新日時', '更新日時', () => namesAre('docs,pic.png,a.txt')],
  ['並び替え: 降順', '降順', () => namesAre('docs,a.txt,pic.png')],
  ['並び替え: 昇順', '昇順', () => namesAre('docs,pic.png,a.txt')],
];
for (const [label, text, after] of MAIN_ITEMS) {
  await openMainMenu();
  if (!(await evalJs(`!!document.querySelector('.file-explorer-menu')`))) {
    expect(`${label}: メニューが開く`, false);
    continue;
  }
  if (await pressItem(label, text)) {
    // 操作の結果（メニューは閉じる。項目ごとの見え方も確かめる）
    expect(`${label}: 押したあとメニューが閉じる`, !(await evalJs(`!!document.querySelector('.file-explorer-menu')`)));
    expect(`${label}: 効果が出る`, Boolean(await after()));
    // 戻す（選択・表示・ダイアログ）
    if (text === '新しいフォルダ') await evalJs(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.includes('キャンセル'))?.click(), 1`).then(() => sleep(200));
    if (text === '選択モード') {
      await openMainMenu();
      await pressItem('選択モードをやめる', '選択モードをやめる');
    }
  }
}

// 項目の「…」メニュー（行の 1 つ）
await closeToasts();
const rowBtn = await evalJs(`(()=>{const x=[...document.querySelectorAll('.shared-entry-menu-button')].find(b=>b.getAttribute('aria-label').startsWith('a.txt')); if(!x) return null; const r=x.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
if (!rowBtn) {
  expect('行の「…」が見える', false);
} else {
  await tap(rowBtn[0], rowBtn[1]);
  await sleep(120);
  for (const text of ['名前を変更', 'コピー', '切り取り', '移動…', 'プロパティ', '削除']) {
    const hit = await hitIsInside('.shared-entry-menu-item', text);
    expect(`行の「…」→「${text}」が押せる`, hit === 'ok');
  }
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(120);
}

// トーストが出ている間も、≡ が押せる（トーストは上端に出る。本体は押せず、中のボタンだけ押せる）
await closeToasts();
const rowForToast = await evalJs(`(()=>{const x=[...document.querySelectorAll('.shared-entry-menu-button')].find(b=>b.getAttribute('aria-label').startsWith('a.txt')); if(!x) return null; const r=x.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
if (!rowForToast) {
  expect('トースト用の行の「…」が見える', false);
} else {
  await tap(rowForToast[0], rowForToast[1]);
  await sleep(120);
  const cp = await centerOf('.shared-entry-menu-item', 'コピー');
  if (cp) await tap(cp[0], cp[1]);
  await sleep(200);
  expect('トーストが出ている（コピーの通知）', await evalJs(`!!document.querySelector('.toast')`));
  const menuBtn = `(()=>{const b=document.querySelector('button[aria-label="メニュー"]'); const r=b.getBoundingClientRect(); return {b, x:r.x+r.width/2, y:r.y+r.height/2}})()`;
  expect(
    'トースト表示中に ≡ が押せる（上に何も被らない）',
    (await evalJs(`(()=>{const m=${menuBtn}; return m.b.contains(document.elementFromPoint(m.x, m.y))})()`)) === true,
  );
  const mp = await evalJs(`(()=>{const m=${menuBtn}; return [m.x, m.y]})()`);
  await tap(mp[0], mp[1]);
  await sleep(150);
  expect('トースト表示中に ≡ を押すとメニューが開く', await evalJs(`!!document.querySelector('.file-explorer-menu')`));
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(120);
  const xp = await centerOf('.toast-close', '');
  expect('トーストの「閉じる」は押せる', xp !== null && (await evalJs(`(()=>{const b=document.querySelector('.toast-close'); const r=b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)) === true);
  if (xp) await tap(xp[0], xp[1]);
  await sleep(200);
  expect('トーストの「閉じる」で通知が消える', !(await evalJs(`!!document.querySelector('.toast')`)));
}

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
cleanup();
if (failures.length > 0) {
  console.error(`\n押せなかった項目: ${failures.length} 件`);
  process.exit(1);
}
console.log('\n全部押せました');
