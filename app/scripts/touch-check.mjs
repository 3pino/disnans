#!/usr/bin/env node
// 実物の画面で、共有フォルダの「≡」メニューと項目の「…」メニューが、タッチで押せるかを確かめる（batch11）。
// vitest の外で動く（Chromium が要る）。使い方:
//   1) 別のターミナルで `npm run dev`（例: http://127.0.0.1:5173。vite の開発サーバーだけでよい）
//   2) CHROME_BIN=<chromium か headless_shell のパス> DISNANS_URL=http://127.0.0.1:5173 node scripts/touch-check.mjs
// Tauri の IPC は scripts/touch-fixture.mjs が読み込み前に差し込む（本体に test mode は無い）。共有フォルダの一覧は、このスクリプトが立てる仮のサーバーから読む（本物のサーバー・Tauri は要らない）。
// 起動したプロセス（Chromium と仮のサーバー）だけを止める。終了コードは 0（全部押せた）か 1。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureScript } from './touch-fixture.mjs';

const CHROME = process.env.CHROME_BIN;
const APP = process.env.DISNANS_URL;
if (!CHROME || !APP) {
  console.error('CHROME_BIN と DISNANS_URL を指定してください');
  process.exit(2);
}

// ---- 仮のサーバー（/api/shared・/api/shared-trash・/api/shared-size を、小さなメモリ上のフォルダで返す） ----
const now = Date.now();
const entry = (path, kind, size = 0, mime = null) => ({ name: path.split('/').pop(), path, kind, size, modified: now - 6e4, mime, message_id: null, file_id: null });
/** パス → 項目。フォルダの一覧は、直下の子を集めて作る */
const fs = new Map([
  ['docs', entry('docs', 'dir')],
  ['a.txt', entry('a.txt', 'file', 12, 'text/plain')],
  ['pic.png', entry('pic.png', 'file', 2048, 'image/png')],
  ['docs/memo.md', entry('docs/memo.md', 'file', 5, 'text/markdown')],
]);
// 並び替えの確認が使う更新日時（docs が新しく、pic.png は a.txt より古い）
fs.get('docs').modified = now - 3e5;
fs.get('pic.png').modified = now - 9e5;
const trash = new Map();
/** 受けた要求（method, path, body）。確認と、未対応の要求の検出に使う */
const requests = [];
const unknownRest = [];
/** 本物のサーバーが流す files.changed（fixture が chat の event として本体へ流す）。変えた項目のパスと、仮想の .trash */
const changedPaths = [];
const changed = (...paths) => changedPaths.push(...paths);
let trashSeq = 0;
/** 26 文字の ULID 風の ID（先頭は 0〜7。連番で一意） */
const ulid = () => `01J${String(++trashSeq).padStart(23, '0')}`;
/** 仮想の .trash/ を使うか（実在の .trash があるときの無効化を確かめるときだけ false） */
let virtualTrash = true;
const trashAlias = (t) => `.trash/${t.id}--${t.original_path.split('/').pop()}`;
const trashView = (t) => { const { items, ...v } = t; return { ...v, trash_path: trashAlias(t) }; };
const trashEntry = (t, base) => ({ ...base, trash: { kind: 'item', entry: trashView(t) } });
let failSize = false;
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const childrenOf = (dir) => [...fs.values()].filter((e) => parentOf(e.path) === dir);
const walk = (dir) => [...fs.values()].filter((e) => e.path.startsWith(dir ? dir + '/' : ''));
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body));
const fake = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  let body = null;
  if ((req.headers['content-type'] ?? '').includes('json') && raw.length) body = JSON.parse(raw.toString());
  requests.push({ method: req.method, path, body, bytes: raw.length });
  const rel = (prefix) => path.slice(prefix.length).replace(/^\//, '').replace(/\/$/, '');
  if (req.method === 'GET' && path === '/__test/events') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return json(res, 200, { next: changedPaths.length, paths: changedPaths.slice(since) });
  }
  if (req.method === 'GET' && (path === '/api/shared' || path.startsWith('/api/shared/'))) {
    const dir = rel('/api/shared');
    if (virtualTrash && (dir === '.trash' || dir.startsWith('.trash/'))) {
      const rest = dir.slice('.trash'.length).replace(/^\//, '');
      if (rest === '') return json(res, 200, { path: dir, entries: [...trash.values()].map((t) => trashEntry(t, { ...entry(trashAlias(t), t.kind === 'dir' ? 'dir' : 'file', t.size), name: trashAlias(t).split('/').pop() })) });
      const [alias, ...sub] = rest.split('/');
      const t = [...trash.values()].find((x) => trashAlias(x) === `.trash/${alias}`);
      if (!t) return json(res, 404, { error: 'not_found' });
      const base = t.original_path + (sub.length ? '/' + sub.join('/') : '');
      const kids = t.items.filter((x) => parentOf(x.path) === base);
      return json(res, 200, { path: dir, entries: kids.map((x) => ({ ...x, path: `.trash/${alias}${x.path.slice(t.original_path.length)}`, trash: { kind: 'descendant', id: t.id } })) });
    }
    if (dir === '' || fs.get(dir)?.kind === 'dir') {
      const kids = childrenOf(dir);
      if (dir === '' && virtualTrash) kids.push({ ...entry('.trash', 'dir'), trash: { kind: 'root' } });
      return json(res, 200, { path: dir, entries: kids });
    }
    return json(res, 404, { error: 'not_found' });
  }
  if (req.method === 'POST' && path === '/api/shared' && body) {
    const { op } = body;
    if (op === 'mkdir') { fs.set(body.path, entry(body.path, 'dir')); changed(body.path); return json(res, 200, fs.get(body.path)); }
    if ((op === 'move' || op === 'copy' || op === 'mkdir') && virtualTrash && [body.from, body.to, body.path].some((x) => typeof x === 'string' && (x === '.trash' || x.startsWith('.trash/')))) {
      const t = op === 'move' ? [...trash.values()].find((x) => trashAlias(x) === body.from) : null;
      if (t && body.to === t.original_path) {
        if (fs.has(t.original_path)) return json(res, 409, { code: 'exists', message: 'exists' });
        if (t.original_path.includes('/') && !fs.has(parentOf(t.original_path))) return json(res, 409, { code: 'parent_missing', message: 'parent' });
        for (const x of t.items) fs.set(x.path, x);
        trash.delete(t.id);
        changed(t.original_path, '.trash');
        return json(res, 200, fs.get(t.original_path));
      }
      if (op === 'copy' && typeof body.from === 'string' && body.from.startsWith('.trash/') && !String(body.to).startsWith('.trash')) {
        // 外へのコピーは許可（仮サーバーは中身を作らず、項目だけ置く）
        fs.set(body.to, entry(body.to, 'file', 0));
        return json(res, 200, fs.get(body.to));
      }
      return json(res, 403, { code: 'forbidden', message: 'forbidden' });
    }
    if (op === 'move' || op === 'copy') {
      // 宛先に同名のフォルダがあれば、overwrite でも 409（サーバーの契約）
      if (fs.has(body.to) && (!body.overwrite || fs.get(body.to).kind === 'dir')) return json(res, 409, { code: 'exists', message: 'exists' });
      for (const e of walk(body.from).concat(fs.has(body.from) ? [fs.get(body.from)] : [])) {
        const np = body.to + e.path.slice(body.from.length);
        fs.set(np, { ...e, path: np, name: np.split('/').pop() });
        if (op === 'move') fs.delete(e.path);
      }
      changed(body.to, ...(op === 'move' ? [body.from] : []));
      return json(res, 200, fs.get(body.to));
    }
  }
  if (virtualTrash && path.startsWith('/api/shared/.trash/') && ['PUT', 'DELETE'].includes(req.method)) {
    const rest = rel('/api/shared').slice('.trash/'.length);
    const t = [...trash.values()].find((x) => trashAlias(x) === `.trash/${rest}`);
    if (req.method === 'DELETE' && t) { trash.delete(t.id); changed(t.original_path, '.trash'); return void res.writeHead(204).end(); }
    return json(res, 403, { code: 'forbidden', message: 'forbidden' });
  }
  if (req.method === 'PUT' && path.startsWith('/api/shared/')) {
    const p = rel('/api/shared');
    fs.set(p, entry(p, 'file', raw.length));
    changed(p);
    return json(res, 200, fs.get(p));
  }
  if (req.method === 'GET' && path === '/api/shared-trash') return json(res, 200, { entries: [...trash.values()].map(trashView) });
  if (req.method === 'POST' && path === '/api/shared-trash' && body) {
    if (body.op === 'trash') {
      const e = fs.get(body.path);
      if (!e) return json(res, 404, { code: 'not_found', message: 'not found' });
      const id = ulid();
      const t = { id, original_path: body.path, kind: e.kind, size: e.size, deleted_at: Date.now() };
      trash.set(id, { ...t, items: [e, ...walk(body.path)] });
      changed(body.path, '.trash');
      for (const x of [e, ...walk(body.path)]) fs.delete(x.path);
      return json(res, 200, trashView(trash.get(id)));
    }
    if (body.op === 'restore') {
      const t = trash.get(body.id);
      if (!t) return json(res, 404, { code: 'not_found', message: 'not found' });
      if (fs.has(t.original_path)) return json(res, 409, { code: 'exists', message: 'exists' });
      if (t.original_path.includes('/') && !fs.has(parentOf(t.original_path))) return json(res, 409, { code: 'parent_missing', message: 'parent' });
      for (const x of t.items) fs.set(x.path, x);
      trash.delete(body.id);
      changed(t.original_path, '.trash');
      return json(res, 200, fs.get(t.original_path));
    }
  }
  if (req.method === 'DELETE' && path.startsWith('/api/shared-trash/')) {
    const gone = trash.get(rel('/api/shared-trash'));
    trash.delete(rel('/api/shared-trash'));
    if (gone) changed(gone.original_path, '.trash');
    return void res.writeHead(204).end();
  }
  if (req.method === 'GET' && (path === '/api/shared-size' || path.startsWith('/api/shared-size/'))) {
    if (failSize) return json(res, 500, { code: 'internal', message: 'size failed' });
    const p = rel('/api/shared-size');
    const self = fs.get(p);
    const items = self?.kind === 'file' ? [self] : walk(p);
    return json(res, 200, { size: items.reduce((n, e) => n + e.size, 0), files: items.filter((e) => e.kind === 'file').length, dirs: items.filter((e) => e.kind === 'dir').length });
  }
  unknownRest.push(`${req.method} ${path}`);
  json(res, 404, { error: 'not_found' });
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
// タッチ（Android）の操作は実際の touch、デスクトップは実際のマウス（CDP の Input）で行う。DOM の click() では押さない
const IS_ANDROID = process.env.TOUCH_PLATFORM === 'android';
async function tap(x, y) {
  if (IS_ANDROID) {
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  await sleep(150);
}
/** 実際のダブルクリック（マウスの 2 回目の clickCount=2） */
async function dblclick(x, y) {
  await S('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const clickCount of [1, 2]) {
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
  }
  await sleep(200);
}
async function key(k, code, vk, modifiers = 0) {
  await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(150);
}

await S('Page.enable');
await S('Runtime.enable');
if (IS_ANDROID) {
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
} else {
  await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
}
// Tauri の IPC 境界だけを fixture で差し込む（本体へは test mode を入れない）。サーバーは仮のサーバー
await S('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript({ server: FAKE, platform: process.env.TOUCH_PLATFORM === 'android' ? 'android' : 'linux' }) });
await S('Page.navigate', { url: APP + '/' });
await sleep(2500);
if (process.env.TOUCH_DEBUG) console.log('ipc:', await evalJs('JSON.stringify([...new Set(window.__ipcLog)])'), 'unknown IPC:', await evalJs('JSON.stringify(window.__ipcUnknown)'), (await evalJs('document.body.innerText')).slice(0, 200));

// 共有フォルダを開く。デスクトップはコマンドパレット（F2）から、Android はナビバーの項目から
if (IS_ANDROID) {
  for (let i = 0; i < 40 && !(await evalJs(`document.querySelectorAll('.nav-bar-item').length >= 3`)); i++) await sleep(250);
  const nav = await evalJs(`(()=>{const b=[...document.querySelectorAll('.app-nav-bar button, nav button')].find(x=>/共有フォルダ|Files|ファイル/i.test(x.textContent+x.getAttribute('aria-label'))); if(!b) return null; const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  if (nav) await tap(nav[0], nav[1]);
  await sleep(900);
} else {
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
  await sleep(400);
  await S('Input.insertText', { text: '共有フォルダを開く' });
  await sleep(300);
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(900);
}
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
/** 出ているトーストの「閉じる」を、タッチで押して閉じる（被っていれば閉じない） */
async function tapCloseToasts() {
  for (let i = 0; i < 6; i++) {
    const p = await evalJs(`(()=>{const b=document.querySelector('.toast-close'); if(!b) return null; const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
    if (!p) return;
    await tap(p[0], p[1]);
    await sleep(150);
  }
}
/** ボタンをタッチで押す。押せる位置か（上に何も被らない）を確かめ、被っていれば NG にして押さない（DOM からは押さない） */
async function pressDom(label, sel, text) {
  const hit = await hitIsInside(sel, text);
  expect(`${label}が押せる（上に何も被らない）`, hit === 'ok');
  if (hit === 'ok') {
    const p = await centerOf(sel, text);
    await tap(p[0], p[1]);
  }
  await sleep(300);
  return hit === 'ok';
}
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

// ======== ドラッグ＆ドロップ・ゴミ箱・サイズ（DOM のイベントと矩形だけで確かめる。見た目は判断しない） ========
// HTML5 の drag イベントを、ページの中で DataTransfer 付きで発火する（CDP の Input では OS のドラッグが始まらないため）。
await evalJs(`(() => {
  const row = (name) => [...document.querySelectorAll('.file-explorer-item')].find((x) => x.querySelector('.file-explorer-name')?.textContent === name);
  const fire = (el, type, init = {}) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...init });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  window.__tc = {
    row,
    names: () => [...document.querySelectorAll('.file-explorer-item .file-explorer-name')].map((x) => x.textContent),
    start: (name, init) => { window.__dt = new DataTransfer(); fire(row(name), 'dragstart', init); },
    over: (el, init) => fire(el, 'dragover', init),
    drop: (el, init) => fire(el, 'drop', init),
    end: (name) => { fire(row(name) ?? document.body, 'dragend'); window.__dt = null; },
    crumb: (text) => [...document.querySelectorAll('.file-explorer-crumbs button')].find((b) => b.textContent.trim() === text),
  };
  return 1;
})()`);
const waitFor = async (expr, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalJs(expr)) return true;
    await sleep(100);
  }
  return false;
};
const reqSince = (from) => requests.slice(from).filter((r) => r.method !== 'GET');
const mark = () => requests.length;
const bodyOf = (r) => JSON.stringify(r.body);
const tcNames = () => evalJs(`window.__tc.names().join(',')`);

/** 行の中心（行の本体）。見つからなければ null */
const rowCenter = (name) => evalJs(`(()=>{const r=window.__tc.row(${JSON.stringify(name)})?.querySelector('.file-explorer-row')?.getBoundingClientRect(); return r ? [r.x+r.width/2, r.y+r.height/2] : null})()`);
/** 行を選ぶ。Android は最初の 1 件を長押し（選択モード）、あとは単タップ。デスクトップは単クリックで選び直す（常に隠れた選択モード） */
async function selectRow(name, first = false) {
  if (IS_ANDROID && first) {
    const lp = await evalJs(`(()=>{const r=window.__tc.row(${JSON.stringify(name)})?.querySelector('.file-explorer-icon')?.getBoundingClientRect(); return r ? [r.x+r.width/2, r.y+r.height/2] : null})()`);
    if (!lp) return false;
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lp[0], y: lp[1], id: 1 }] });
    await sleep(600);
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    const p = await rowCenter(name);
    if (!p) return false;
    await tap(p[0], p[1]);
  }
  await sleep(150);
  return true;
}
/** フォルダを開く。Android は単タップ、デスクトップは実際のダブルクリック */
async function openRow(name) {
  const p = await rowCenter(name);
  if (!p) return false;
  if (IS_ANDROID) await tap(p[0], p[1]);
  else await dblclick(p[0], p[1]);
  await sleep(250);
  return true;
}
/** パンくずの項目を押す（本当のタップ・クリック） */
const pressCrumb = async (text) => {
  const p = await evalJs(`(()=>{const b=window.__tc.crumb(${JSON.stringify(text)}); if(!b) return null; const r=b.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  if (!p) return false;
  await tap(p[0], p[1]);
  await sleep(250);
  return true;
};
const toolbarLabels = () => evalJs(`[...document.querySelectorAll('.file-explorer-selection-actions button')].map(b=>b.getAttribute('aria-label')).filter(Boolean).join(',')`);

async function androidBaseline() {
/** 一覧の名前の並び（フォルダ → 項目の順）。並べ方の確認に使う */
const namesAre = (want) => evalJs(`[...document.querySelectorAll('.file-explorer-item .file-explorer-name')].map(x=>x.textContent).join(',') === ${JSON.stringify(want)}`);

const MAIN_ITEMS = [
  ['新しいフォルダ', '新しいフォルダ', () => evalJs(`!!document.querySelector('.file-explorer-mkdir')`)],
  ['表示: アイコン', 'アイコン', () => evalJs(`!!document.querySelector('.file-explorer-view-grid')`)],
  ['表示: 詳細', '詳細', () => evalJs(`!!document.querySelector('.file-explorer-columns')`)],
  ['並び替え: 更新日時', '更新日時', () => namesAre('docs,.trash,pic.png,a.txt')],
  ['並び替え: 降順', '降順', () => namesAre('.trash,docs,a.txt,pic.png')],
  ['並び替え: 昇順', '昇順', () => namesAre('docs,.trash,pic.png,a.txt')],
];
expect('≡ に「選択モード」「一覧」「貼り付け」「アップロード」は無い', await (async () => {
  await openMainMenu();
  const ok = await evalJs(`[...document.querySelectorAll('.file-explorer-menu .menu-item')].every(b=>!/選択モード|^一覧|貼り付け|アップロード/.test(b.textContent.trim()))`);
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(120);
  return ok;
})());
// （ブラウザーでは、許可を求めずにクリップボードの中身を確かめられないので、貼り付けは押せるまま。Tauri では中身が無ければ押せない）
expect('選択のバーの削除の左に貼り付けがある', (await evalJs(`(()=>{const bs=[...document.querySelectorAll('.file-explorer-selection-actions button')].map(b=>b.getAttribute('aria-label')); return bs.indexOf('貼り付け') === bs.indexOf('削除') - 1})()`)) === true);
// 空きスペースの長押しで、アップロードのメニューが押したところに出る
{
  const spot = await evalJs(`(()=>{const b=document.querySelector('.file-explorer-body').getBoundingClientRect(); return [b.x+b.width/2, b.bottom-40]})()`);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot[0], y: spot[1], id: 1 }] });
  await sleep(600);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  expect('空きスペースの長押しでメニューが出て、指を離しても閉じない', (await evalJs(`!!document.querySelector('.file-explorer-context .menu')`)) === true);
  expect('長押しのメニューの「アップロード」が押せる', (await hitIsInside('.file-explorer-context .menu-item', 'アップロード')) === 'ok');
  expect('長押しのメニューは画面に収まる', (await evalJs(`(()=>{const r=document.querySelector('.file-explorer-context .menu').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`)) === true);
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(150);
}
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
    // 戻す（ダイアログ・選択モード）。選択モードは空きスペースを押して解除する
    if (text === '新しいフォルダ') await evalJs(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.includes('キャンセル'))?.click(), 1`).then(() => sleep(200));
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
  expect('行の「…」→「プロパティ」が押せる', (await hitIsInside('.shared-entry-menu-item', 'プロパティ')) === 'ok');
  expect('行の「…」はプロパティだけ', (await evalJs(`[...document.querySelectorAll('.shared-entry-menu-item')].map(b=>b.textContent.trim()).join(',')`)) === 'プロパティ');
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(120);
}

// 詳細の「…」は右端に固定（sticky）していて行ごとに層を作るので、先頭の行のメニューが下の行の「…」に覆われないか（右端まで）
{
  const first = await evalJs(`(()=>{const r=document.querySelector('.shared-entry-menu-button').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  await tap(first[0], first[1]);
  await sleep(150);
  expect('先頭の行の「…」のメニューが、下の行の「…」に覆われない', (await evalJs(`(()=>{const m=document.querySelector('.shared-entry-menu-item'); if(!m) return false; const r=m.getBoundingClientRect(); return [r.x+6, r.x+r.width/2, r.right-6].every(x=>m.contains(document.elementFromPoint(x, r.y+r.height/2)))})()`)) === true);
  await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
  await sleep(120);
}

// 詳細: 狭い画面では横にはみ出し（スワイプで見る）、「…」はどの行も画面の中に見える
expect('詳細は横にはみ出してスクロールできる（390px）', (await evalJs(`(()=>{const b=document.querySelector('.file-explorer-body'); return b.scrollWidth > b.clientWidth})()`)) === true);
expect('詳細の「…」は、どの行も画面の中（右端に固定）', (await evalJs(`[...document.querySelectorAll('.shared-entry-menu-button')].every(x=>{const r=x.getBoundingClientRect(); return r.right <= innerWidth && document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)?.closest('.shared-entry-menu-button')===x})`)) === true);
await evalJs(`(()=>{const b=document.querySelector('.file-explorer-body'); b.scrollLeft = b.scrollWidth; return 1})()`);
await sleep(100);
expect('横にスクロールしても「…」は画面の中', (await evalJs(`[...document.querySelectorAll('.shared-entry-menu-button')].every(x=>{const r=x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth})`)) === true);
await evalJs(`document.querySelector('.file-explorer-body').scrollLeft = 0, 1`);

// アイコン表示: 左の列の「…」のメニューが、画面の左にはみ出さない
await openMainMenu();
await pressItem('表示: アイコン', 'アイコン');
const leftBtn = await evalJs(`(()=>{const xs=[...document.querySelectorAll('.shared-entry-menu-button')].map(b=>b.getBoundingClientRect()).sort((a,b)=>a.left-b.left); const r=xs[0]; return [r.x+r.width/2, r.y+r.height/2]})()`);
await tap(leftBtn[0], leftBtn[1]);
await sleep(150);
expect('アイコン表示の左端の「…」のメニューが画面に収まる', (await evalJs(`(()=>{const m=document.querySelector('.shared-entry-menu'); if(!m) return false; const r=m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth})()`)) === true);
await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
await sleep(120);
expect('アイコン表示の下に、項目 1 つ分くらいの空きがある', (await evalJs(`(()=>{const l=document.querySelector('.file-explorer-list'); const li=l.querySelector('.file-explorer-item'); return parseFloat(getComputedStyle(l).paddingBottom) >= li.getBoundingClientRect().height * 0.8})()`)) === true);
await openMainMenu();
await pressItem('表示: 詳細', '詳細');

// 名前の文字を押すと、その場で入力欄になる（全画面のダイアログではない）。Esc で取り消す
const nameSpot = await evalJs(`(()=>{const n=[...document.querySelectorAll('.file-explorer-name-text')].find(x=>x.textContent==='a.txt'); const r=n.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
await tap(nameSpot[0], nameSpot[1]);
await sleep(200);
expect('名前を押すと、その行の名前が入力欄になる', (await evalJs(`!!document.querySelector('.file-explorer-item .file-explorer-rename') && !document.querySelector('.modal') && document.activeElement?.classList.contains('file-explorer-rename')`)) === true);
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(150);
expect('Esc で入力欄が元の名前に戻る', (await evalJs(`!document.querySelector('.file-explorer-rename') && !!document.querySelector('.shell-panel-files')`)) === true);

// トーストが出ている間も、≡ が押せる（トーストは上端に出る。本体は押せず、中のボタンだけ押せる）
// 本物の通知を出す: 選択にフォルダを混ぜてコピーすると「フォルダはコピーできないので…」が出る
await closeToasts();
await evalJs(`document.querySelector('.file-explorer-menu')?.remove(), 1`);
const selectBtns = async () => {
  // 長押しで選択モードに入り（docs）、a.txt も選ぶ（一覧の行を押す）
  const lp = await evalJs(`(()=>{const li=[...document.querySelectorAll('.file-explorer-item')].find(x=>x.textContent.includes('docs')); const r=li.querySelector('.file-explorer-icon').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
  await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lp[0], y: lp[1], id: 1 }] });
  await sleep(600);
  await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  for (const name of ['a.txt']) {
    const p = await evalJs(`(()=>{const li=[...document.querySelectorAll('.file-explorer-item')].find(x=>x.textContent.includes('${name}')); const r=li.querySelector('.file-explorer-row').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
    await tap(p[0], p[1]);
    await sleep(120);
  }
};
await selectBtns();
expect('選んだ件数が出る（2 件選択中）', (await evalJs(`document.querySelector('.file-explorer-selection-count')?.textContent`)) === '2 件選択中');
// 本物の通知: 選んだ 2 件をゴミ箱に移すと、「取り消す」付きのトーストが出る（取り消しは、このブロックの最後で押す）
const delBtn = await centerOf('button[aria-label="削除"]', '');
if (delBtn) await tap(delBtn[0], delBtn[1]);
await sleep(250);
{
  const okp = await centerOf('.modal button, .confirm-dialog-actions button', 'ゴミ箱に移す');
  if (okp) await tap(okp[0], okp[1]);
}
await sleep(500);
expect('ゴミ箱に移すと通知が出る（本物の通知）', await evalJs(`!!document.querySelector('.toast')`));
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
// ゴミ箱は、ふつうのフォルダ（ルートの `.trash`）。ハンバーガーに「ゴミ箱」の項目は無く、ルートに `.trash` の行が見える
await openMainMenu();
expect('≡ に「ゴミ箱」の項目は無い', await evalJs(`[...document.querySelectorAll('.file-explorer-menu .menu-item')].every(b=>!b.textContent.includes('ゴミ箱'))`));
await evalJs(`document.querySelector('.menu-backdrop')?.click(), 1`);
await sleep(120);
expect('ルートに「.trash」の行が見える', await evalJs(`window.__tc.names().includes('.trash')`));
// 後の検査のために、2 件を .trash から元の場所へ戻す（取り消しのトーストは閉じたので）
{
  expect('.trash を開ける（単タップ）', await openRow('.trash'));
  expect('.trash の中に、元の名前（docs・a.txt）で並ぶ', await waitFor(`(()=>{const n=window.__tc.names(); return n.includes('docs') && n.includes('a.txt')})()`));
  expect('パンくずに .trash が出る', await evalJs(`[...document.querySelectorAll('.file-explorer-crumbs button')].some(b=>b.textContent.trim()==='.trash')`));
  const m = mark();
  await selectRow('docs', true);
  await selectRow('a.txt');
  expect('.trash で全部ゴミ箱の項目を選ぶと、「元へ戻す」と「完全削除」が出て「削除」は無い', (await toolbarLabels()).includes('元へ戻す') && (await toolbarLabels()).includes('完全削除') && !(await toolbarLabels()).split(',').includes('削除'));
  await pressDom('選択のバーの「元へ戻す」', '.file-explorer-selection-actions button[aria-label="元へ戻す"]', '');
  await sleep(500);
  expect('元へ戻すで、restore の要求が 2 件届く（正しい 26 文字の ID）', reqSince(m).filter((r) => r.path === '/api/shared-trash' && r.body?.op === 'restore' && /^[0-7][0-9A-Z]{25}$/.test(r.body.id)).length === 2);
  expect('元へ戻したら、.trash の中が空になる', await waitFor(`window.__tc.names().length === 0`));
  expect('戻した項目の選択は残らない', (await evalJs(`!document.querySelector('.file-explorer-selection-count')?.textContent.includes('選択中')`)) === true);
  expect('パンくずで共有フォルダへ戻れる', await pressCrumb('共有フォルダ'));
  expect('共有フォルダの一覧に docs と a.txt が戻っている', await waitFor(`(()=>{const n=window.__tc.names(); return n.includes('docs') && n.includes('a.txt')})()`));
}
// （Alt+← は Android では使わない（戻るボタン）。デスクトップの検査で確かめる）
await selectBtns();
// 選択を空きスペースで解除する（件数に戻り、操作は押せない）
// 空きスペース: 一覧の項目の外（一覧の下の余白。項目が余白まで届かないときは、本文の下端）
const emptySpot = await evalJs(`(()=>{const b=document.querySelector('.file-explorer-body'); const list=document.querySelector('.file-explorer-list'); const r=b.getBoundingClientRect(); const lr=list.getBoundingClientRect(); const y=Math.min(r.bottom-8, lr.bottom+ (r.bottom-lr.bottom)/2); const x=r.x+r.width/2; const hit=document.elementFromPoint(x,y); return {x, y, onEmpty: !hit?.closest('.file-explorer-item, .file-explorer-bar, .file-explorer-crumbs, .file-explorer-menu')}})()`);
if (!emptySpot.onEmpty) console.log('（注意: 空きスペースの位置が項目の上）');
await tap(emptySpot.x, emptySpot.y);
await sleep(150);
expect('空きスペースで選択が解除される（件数に戻る）', (await evalJs(`document.querySelector('.file-explorer-selection-count')?.textContent`)) === '4 件');
expect('選んでいないとき、コピーは押せない', (await evalJs(`document.querySelector('button[aria-label="コピー"]')?.disabled === true`)) === true);
expect('パンくずは上端の下の行にある', (await evalJs(`document.querySelector('.panel-bar')?.nextElementSibling?.classList.contains('file-explorer-crumbs') === true`)) === true);
expect('上端に「閉じる」は無い', (await evalJs(`!document.querySelector('.file-explorer-bar button[aria-label="閉じる"]')`)) === true);

}

async function desktopChecks() {
  const count = () => evalJs(`document.querySelector('.file-explorer-selection-count')?.textContent ?? null`);
  const checks = () => evalJs(`document.querySelectorAll('.file-explorer input[type="checkbox"], .file-explorer [role="checkbox"]').length`);
  const total = await evalJs(`window.__tc.names().length`);
  expect(`デスクトップ: 選択が 0 件のとき、ふつうの件数（${total} 件）が出て、チェックボックスは無い`, (await count()) === `${total} 件` && (await checks()) === 0);
  await selectRow('docs');
  expect('デスクトップ: 単クリックで 1 件選ばれる（0→1）', (await count()) === '1 件選択中');
  await selectRow('docs');
  expect('デスクトップ: もう一度クリックで選択が外れ、ふつうの表示に戻る（1→0）', (await count()) === `${total} 件` && (await checks()) === 0);
  await selectRow('docs');
  expect('デスクトップ: もう一度クリックで 1 件選ばれる（0→1）', (await count()) === '1 件選択中');
  await selectRow('docs');
  // ダブルクリック: 開く（選択に巻き込まれない）
  expect('デスクトップ: ダブルクリックでフォルダが開く', (await openRow('docs')) && (await waitFor(`window.__tc.names().includes('memo.md')`)));
  expect('デスクトップ: 開いたあと、選択は残らない', (await evalJs(`!document.querySelector('.file-explorer-selection-count')?.textContent.includes('選択中')`)) === true);
  expect('デスクトップ: パンくずで共有フォルダへ戻れる', (await pressCrumb('共有フォルダ')) && (await waitFor(`window.__tc.names().includes('docs')`)));
  // Enter: 選んだ項目を開く
  await selectRow('docs');
  await key('Enter', 'Enter', 13);
  expect('デスクトップ: Enter で選んだフォルダが開く', await waitFor(`window.__tc.names().includes('memo.md')`));
  await pressCrumb('共有フォルダ');
  await waitFor(`window.__tc.names().includes('docs')`);
  // F2: 選んだ項目の名前の変更（コマンドパレットではなく）
  await selectRow('a.txt');
  await key('F2', 'F2', 113);
  expect('デスクトップ: F2 で名前の入力欄が出る（コマンドパレットは開かない）', (await evalJs(`!!document.querySelector('.file-explorer-item .file-explorer-rename') && !document.querySelector('[aria-label*="コマンド"]')`)) === true);
  await key('Escape', 'Escape', 27);
  // 選択を外してから、ゴミ箱の流れ（共通）へ
  await selectRow('a.txt');
  expect('デスクトップ: ルートに「.trash」の行が見え、≡ に「ゴミ箱」は無い', (await evalJs(`window.__tc.names().includes('.trash')`)) === true && (await evalJs(`[...document.querySelectorAll('.file-explorer-menu .menu-item')].every(b=>!b.textContent.includes('ゴミ箱'))`)) === true);
}

async function sharedFlows() {
// ---- 内部 DnD: 移動 ----
{
  const dragMove = async () => {
    await evalJs(`window.__tc.start('a.txt')`);
    await evalJs(`window.__tc.over(window.__tc.row('docs'))`);
    return evalJs(`window.__tc.drop(window.__tc.row('docs'))`);
  };
  let m = mark();
  await evalJs(`window.__tc.start('a.txt')`);
  const hit = await evalJs(`window.__tc.over(window.__tc.row('docs'))`);
  expect('内部 DnD: フォルダの上でドロップを受け付ける（dragover を取り消した）', hit === true);
  expect('内部 DnD: ドロップ先のフォルダがハイライトされる', await waitFor(`!!document.querySelector('.file-explorer-item-drag-target')`));
  expect('内部 DnD: ハイライトは docs だけ', (await evalJs(`[...document.querySelectorAll('.file-explorer-item-drag-target .file-explorer-name')].map(x=>x.textContent).join(',')`)) === 'docs');
  await evalJs(`window.__tc.drop(window.__tc.row('docs'))`);
  await sleep(500);
  const isMove = (r) => r.path === '/api/shared' && r.body?.op === 'move' && r.body.from === 'a.txt' && r.body.to === 'docs/a.txt' && !r.body.overwrite;
  const first = reqSince(m).some(isMove);
  expect('内部 DnD: まだ開いていないフォルダへ最初のドロップで、移動の要求が届く（a.txt → docs/a.txt）', first);
  if (!first) {
    // 中身をまだ読んでいないフォルダへの最初のドロップは「読み終えてから…」で止まる。読み込みのあと、もう一度落として続きを確かめる
    await waitFor(`1`);
    await evalJs(`window.__tc.end('docs')`);
    await sleep(400);
    m = mark();
    await dragMove();
    await sleep(500);
  }
  expect('内部 DnD: 移動の要求が届く（a.txt → docs/a.txt）', reqSince(m).some(isMove) || first);
  expect('内部 DnD: 移動したあと、一覧から a.txt が消える', await waitFor(`!window.__tc.names().includes('a.txt')`));
  expect('内部 DnD: 移動のあと、ハイライトが残らない', (await evalJs(`!document.querySelector('.file-explorer-item-drag-target')`)) === true);
  await evalJs(`window.__tc.end('docs')`);
}
// ---- 内部 DnD: Ctrl でコピー（読み込み前のドロップは上の検査で報告済み。ここは 2 回まで試す） ----
{
  let m = mark();
  const isCopy = (r) => r.path === '/api/shared' && r.body?.op === 'copy' && r.body.from === 'pic.png' && r.body.to === 'docs/pic.png';
  for (let i = 0; i < 2 && !reqSince(m).some(isCopy); i++) {
    m = mark();
    await evalJs(`window.__tc.start('pic.png')`);
    await evalJs(`window.__tc.over(window.__tc.row('docs'), { ctrlKey: true })`);
    await evalJs(`window.__tc.drop(window.__tc.row('docs'), { ctrlKey: true })`);
    await sleep(600);
    await evalJs(`window.__tc.end('docs')`);
  }
  expect('内部 DnD: Ctrl でコピーの要求が届く（pic.png → docs/pic.png）', reqSince(m).some(isCopy));
  expect('内部 DnD: コピーでは元の pic.png が残る', (await evalJs(`window.__tc.names().includes('pic.png')`)) === true);
}
// ---- 内部 DnD: 自分自身へは落とせない ----
{
  const m = mark();
  await evalJs(`window.__tc.start('docs')`);
  await evalJs(`window.__tc.over(window.__tc.row('docs'))`);
  expect('内部 DnD: 自分自身にはハイライトが付かない', (await evalJs(`!document.querySelector('.file-explorer-item-drag-target')`)) === true);
  await evalJs(`window.__tc.drop(window.__tc.row('docs'))`);
  await sleep(300);
  expect('内部 DnD: 自分自身へのドロップでは要求が出ない', reqSince(m).length === 0);
  await evalJs(`window.__tc.end('docs')`);
}
// ---- 内部 DnD: パンくずへ（親のフォルダへ移す） ----
{
  await openRow('docs');
  expect('docs フォルダを開けた', await waitFor(`window.__tc.names().includes('memo.md')`));
  const m = mark();
  await evalJs(`window.__tc.start('memo.md')`);
  await evalJs(`window.__tc.over(window.__tc.crumb('共有フォルダ'))`);
  expect('内部 DnD: パンくずがハイライトされる', await waitFor(`!!document.querySelector('.file-explorer-crumb-drag-over')`));
  await evalJs(`window.__tc.drop(window.__tc.crumb('共有フォルダ'))`);
  await sleep(500);
  expect('内部 DnD: パンくずへの移動の要求が届く（docs/memo.md → memo.md）', reqSince(m).some((r) => r.body?.op === 'move' && r.body.from === 'docs/memo.md' && r.body.to === 'memo.md'));
  await evalJs(`window.__tc.end('memo.md')`);
  // 現在のフォルダの空きへ落とす（同じフォルダ）と、ハイライトが body に付く。親へ戻る
  await pressCrumb('共有フォルダ');
  expect('共有フォルダへ戻れた', await waitFor(`window.__tc.names().includes('docs')`));
}

// ---- 外部のフォルダのドロップ（DOM の入口の代わりに、フォルダの階層をスタブで渡す。Linux の OS ネイティブのドロップは対象外） ----
{
  const m = mark();
  await evalJs(`(() => {
    const file = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(['x'], name)) });
    const dir = (name, kids) => ({ isFile: false, isDirectory: true, name, createReader: () => { let done = false; return { readEntries: (ok) => { if (done) return ok([]); done = true; ok(kids); } }; } });
    const root = dir('proj', [file('a.txt'), dir('empty', []), dir('sub', [file('b.txt')])]);
    window.__extDt = { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => root }] };
    return 1;
  })()`);
  await evalJs(`(() => { const ev = new Event('dragenter', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: window.__extDt }); document.querySelector('.file-explorer').dispatchEvent(ev); return 1; })()`);
  expect('外部ドロップ: ドロップの領域がハイライトされる', await waitFor(`!!document.querySelector('.file-explorer-body-external-drop')`));
  await evalJs(`(() => { const ev = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: window.__extDt }); document.querySelector('.file-explorer-body').dispatchEvent(ev); return 1; })()`);
  await waitFor(`!!window.__tc.row('proj')`, 4000);
  const sent = reqSince(m);
  const idx = (kind, path) => sent.findIndex((r) => (kind === 'mkdir' ? r.method === 'POST' && r.body?.op === 'mkdir' && r.body.path === path : r.method === 'PUT' && r.path === `/api/shared/${path}`));
  const wanted = [['mkdir', 'proj'], ['put', 'proj/a.txt'], ['mkdir', 'proj/empty'], ['mkdir', 'proj/sub'], ['put', 'proj/sub/b.txt']];
  const got = wanted.map(([k, p]) => idx(k, p));
  expect('外部ドロップ: 階層（フォルダ・ファイル・空フォルダ）の要求がすべて届く', got.every((i) => i >= 0));
  expect('外部ドロップ: 親のフォルダが先に作られる', got[0] < got[1] && got[0] < got[2] && got[0] < got[3] && got[3] < got[4]);
  expect('外部ドロップ: 空のフォルダも作られる（mkdir だけ）', got[2] >= 0 && !sent.some((r) => r.path.startsWith('/api/shared/proj/empty/')));
  expect('外部ドロップ: 終わったあと、ハイライトが消える', (await evalJs(`!document.querySelector('.file-explorer-body-external-drop')`)) === true);
  expect('外部ドロップ: 一覧に proj が出る', await waitFor(`window.__tc.names().includes('proj')`));
}

// ---- ゴミ箱: 削除 → 取り消す ----
async function trashRow(name, first = true) {
  await tapCloseToasts();
  if (!(await selectRow(name, first))) return false;
  const d = await centerOf('button[aria-label="削除"]', '');
  if (!d) return false;
  await tap(d[0], d[1]);
  await sleep(200);
  return true;
}
const confirmOk = async (text) => {
  expect(`確認の「${text}」が押せる（上に何も被らない）`, (await hitIsInside('.modal button, .confirm-dialog-actions button', text)) === 'ok');
  const p = await centerOf('.modal button, .confirm-dialog-actions button', text);
  if (p) await tap(p[0], p[1]);
  await sleep(500);
};
{
  const m = mark();
  expect('ゴミ箱: 削除の操作が押せる', await trashRow('pic.png'));
  await confirmOk('ゴミ箱に移す');
  expect('ゴミ箱: trash の要求が届く（pic.png）', reqSince(m).some((r) => r.path === '/api/shared-trash' && r.body?.op === 'trash' && r.body.path === 'pic.png'));
  expect('ゴミ箱: 一覧から pic.png が消える', await waitFor(`!window.__tc.names().includes('pic.png')`));
  expect('ゴミ箱: トーストの「取り消す」が押せる（上に何も被らない）', (await hitIsInside('.toast button', '取り消す')) === 'ok');
  const up = await centerOf('.toast button', '取り消す');
  if (up) await tap(up[0], up[1]);
  await sleep(500);
  expect('ゴミ箱: 取り消すで restore の要求が届く（trash が返した正しい ID）', reqSince(m).some((r) => r.body?.op === 'restore' && /^[0-7][0-9A-Z]{25}$/.test(r.body.id ?? '')));
  expect('ゴミ箱: 取り消したあと、一覧に pic.png が戻る', await waitFor(`window.__tc.names().includes('pic.png')`));
}
// ---- .trash（ふつうのフォルダ）: 元の名前・完全削除の確認・元へ戻す ----
{
  await trashRow('pic.png');
  await confirmOk('ゴミ箱に移す');
  await tapCloseToasts();
  expect('.trash を開ける', await openRow('.trash'));
  expect('.trash: 削除した項目が元の名前（pic.png）で並ぶ', await waitFor(`window.__tc.names().includes('pic.png')`));
  const alias = [...trash.values()].map(trashAlias).find((a) => a.endsWith('--pic.png'));
  expect('.trash: 実際のパス（別名）は 26 文字の ULID 付き（表示は元の名前）', /^\.trash\/[0-7][0-9A-Z]{25}--pic\.png$/.test(alias ?? ''));
  await selectRow('pic.png', true);
  expect('.trash: 選ぶと「完全削除」「元へ戻す」が出る', (await toolbarLabels()).includes('完全削除') && (await toolbarLabels()).includes('元へ戻す'));
  // 完全削除: まずキャンセル（要求は出ない）
  let m = mark();
  await pressDom('選択のバーの「完全削除」', '.file-explorer-selection-actions button[aria-label="完全削除"]', '');
  expect('完全削除の確認が、元の名前（pic.png）と「取り消せません」を出す', await evalJs(`(()=>{const t=document.querySelector('.modal, .confirm-dialog')?.textContent ?? ''; return t.includes('pic.png') && t.includes('取り消せません')})()`));
  expect('確認の「完全に削除」が押せる位置にある', (await hitIsInside('.modal button, .confirm-dialog-actions button', '完全に削除')) === 'ok');
  const cp = await centerOf('.modal button, .confirm-dialog-actions button', 'キャンセル');
  if (cp) await tap(cp[0], cp[1]);
  await sleep(300);
  expect('キャンセルでは purge の要求が出ず、項目が残る', !reqSince(m).some((r) => r.method === 'DELETE') && (await evalJs(`window.__tc.names().includes('pic.png')`)) === true);
  // 完全削除する
  await pressDom('選択のバーの「完全削除」（2 回目）', '.file-explorer-selection-actions button[aria-label="完全削除"]', '');
  await confirmOk('完全に削除');
  expect('確認のあと purge の要求が届く（DELETE /api/shared/.trash/<別名>）', reqSince(m).some((r) => r.method === 'DELETE' && (r.path === `/api/shared/${alias}` || r.path === `/api/shared-trash/${alias.split('/')[1].split('--')[0]}`)));
  expect('purge した項目が消える', await waitFor(`!window.__tc.names().includes('pic.png')`));
  expect('purge したあと、選択は残らない', (await evalJs(`!document.querySelector('.file-explorer-selection-count')?.textContent.includes('選択中')`)) === true);
  // 元へ戻す（別の項目を、仮サーバーのゴミ箱へ直接入れてから、一覧を読み直す）
  const e = entry('tmp.txt', 'file', 3, 'text/plain');
  const tid = ulid();
  trash.set(tid, { id: tid, original_path: 'tmp.txt', kind: 'file', size: 3, deleted_at: Date.now(), items: [e] });
  changed('tmp.txt', '.trash');
  expect('共有フォルダへ戻って .trash を開き直せる', (await pressCrumb('共有フォルダ')) && (await openRow('.trash')));
  expect('.trash: 追加した tmp.txt が元の名前で並ぶ', await waitFor(`window.__tc.names().includes('tmp.txt')`));
  await selectRow('tmp.txt', true);
  m = mark();
  await pressDom('選択のバーの「元へ戻す」', '.file-explorer-selection-actions button[aria-label="元へ戻す"]', '');
  await sleep(500);
  expect('元へ戻すで restore の要求が届く（ID はその項目の 26 文字）', reqSince(m).some((r) => r.body?.op === 'restore' && r.body.id === tid));
  expect('戻した項目が .trash から消える', await waitFor(`!window.__tc.names().includes('tmp.txt')`));
  // 戻る（履歴）: Alt+← で、ふつうのフォルダと同じく 1 つ前（共有フォルダ）へ
  if (IS_ANDROID) await pressCrumb('共有フォルダ');
  else await key('ArrowLeft', 'ArrowLeft', 37, 1);
  expect(IS_ANDROID ? 'パンくずで .trash から共有フォルダへ戻る' : 'Alt+← で履歴を 1 つ戻る（.trash → 共有フォルダ）', await waitFor(`window.__tc.names().includes('docs') && !document.querySelector('.file-explorer-crumbs')?.textContent.includes('.trash')`));
  expect('戻したあと tmp.txt が共有フォルダにある', await evalJs(`window.__tc.names().includes('tmp.txt')`));
}

// ---- フォルダのサイズ（プロパティ） ----
{
  const openProps = async (name) => {
    const b = await evalJs(`(()=>{const x=window.__tc.row(${JSON.stringify(name)}).querySelector('.shared-entry-menu-button'); if(!x) return null; const r=x.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
    if (!b) return false;
    await tap(b[0], b[1]);
    await sleep(150);
    const p = await centerOf('.shared-entry-menu-item', 'プロパティ');
    if (!p) return false;
    await tap(p[0], p[1]);
    await sleep(200);
    return true;
  };
  const closeProps = () => evalJs(`document.querySelector('.modal-scrim')?.click(), 1`).then(() => sleep(150));
  let m = mark();
  expect('サイズ: フォルダのプロパティを開ける', await openProps('docs'));
  expect('サイズ: /api/shared-size/docs の要求が届く', await waitFor(`1`) && (await sleep(300), requests.slice(m).some((r) => r.method === 'GET' && r.path === '/api/shared-size/docs')));
  expect('サイズ: 結果に「バイト」「ファイル」「フォルダ」が出る', await waitFor(`(()=>{const t=[...document.querySelectorAll('.modal dd')].map(x=>x.textContent).join(' '); return t.includes('バイト') && t.includes('ファイル') && t.includes('フォルダ')})()`));
  await closeProps();
  // 失敗 → 再試行
  failSize = true;
  m = mark();
  await openProps('docs');
  expect('サイズ: 失敗のとき、エラーの表示と再試行ボタンが出る', await waitFor(`!!document.querySelector('.file-properties-size-error') && !!document.querySelector('.file-properties-retry')`));
  expect('サイズ: 再試行ボタンが押せる', (await hitIsInside('.file-properties-retry', '')) === 'ok');
  failSize = false;
  const rp2 = await centerOf('.file-properties-retry', '');
  if (rp2) await tap(rp2[0], rp2[1]);
  expect('サイズ: 再試行で結果が出る（エラーが消える）', await waitFor(`!document.querySelector('.file-properties-size-error') && [...document.querySelectorAll('.modal dd')].some(x=>x.textContent.includes('フォルダ'))`));
  expect('サイズ: 再試行で要求が再び届く', requests.slice(m).filter((r) => r.path === '/api/shared-size/docs').length >= 2);
  await closeProps();
}

}

if (IS_ANDROID) await androidBaseline();
else await desktopChecks();
await sharedFlows();

// 未対応の IPC があれば失敗（本体の機能追加で起動時に呼ぶ IPC が増えた退行を、null で隠さない）
const unknownIpc = JSON.parse(await evalJs('JSON.stringify(window.__ipcUnknown)'));
expect('仮のサーバーに無い REST を本体が呼んでいない' + (unknownRest.length ? `（${[...new Set(unknownRest)].join(', ')}）` : ''), unknownRest.length === 0);
expect('fixture に無い IPC を本体が呼んでいない' + (unknownIpc.length ? `（${unknownIpc.join(', ')}）` : ''), unknownIpc.length === 0);

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
cleanup();
if (failures.length > 0) {
  console.error(`\n押せなかった項目: ${failures.length} 件`);
  process.exit(1);
}
console.log('\n全部押せました');
