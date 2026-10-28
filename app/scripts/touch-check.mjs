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
// Tauri の IPC 境界だけを fixture で差し込む（本体へは test mode を入れない）。サーバーは仮のサーバー
await S('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript({ server: FAKE }) });
await S('Page.navigate', { url: APP + '/' });
await sleep(2500);
if (process.env.TOUCH_DEBUG) console.log('unknown IPC:', await evalJs('JSON.stringify(window.__ipcUnknown)'), (await evalJs('document.body.innerText')).slice(0, 200));

// 共有フォルダを、コマンドパレット（F2）から開く
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 });
await sleep(400);
await S('Input.insertText', { text: '共有フォルダを開く' });
await sleep(300);
await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(900);
// コマンドパレットが開けない環境（ヘッドレスなど）では、開発サーバーのモジュールから直接開く
if (!(await evalJs(`!!document.querySelector('.shell-panel-files')`))) {
  await evalJs(`import('/src/lib/stores/ui.svelte.ts').then((m) => (m.ui.openFiles(), 1))`);
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
  ['新しいフォルダ', '新しいフォルダ', () => evalJs(`!!document.querySelector('.file-explorer-mkdir')`)],
  ['表示: アイコン', 'アイコン', () => evalJs(`!!document.querySelector('.file-explorer-view-grid')`)],
  ['表示: 詳細', '詳細', () => evalJs(`!!document.querySelector('.file-explorer-columns')`)],
  ['並び替え: 更新日時', '更新日時', () => namesAre('docs,pic.png,a.txt')],
  ['並び替え: 降順', '降順', () => namesAre('docs,a.txt,pic.png')],
  ['並び替え: 昇順', '昇順', () => namesAre('docs,pic.png,a.txt')],
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
const cpBtn = await centerOf('button[aria-label="コピー"]', '');
if (cpBtn) await tap(cpBtn[0], cpBtn[1]);
await sleep(200);
expect('フォルダを混ぜてコピーすると通知が出る（本物の通知）', await evalJs(`!!document.querySelector('.toast')`));
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
// 選択中の Alt+← は、選択モードを終える（パネルは閉じない）
await selectBtns();
await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 });
await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 });
await sleep(150);
expect('選択中の Alt+← で選択が解除され、画面はそのまま', (await evalJs(`document.querySelector('.file-explorer-selection-count')?.textContent === '3 件' && !!document.querySelector('.shell-panel-files')`)) === true);
await selectBtns();
// 選択を空きスペースで解除する（件数に戻り、操作は押せない）
// 空きスペース: 一覧の項目の外（一覧の下の余白。項目が余白まで届かないときは、本文の下端）
const emptySpot = await evalJs(`(()=>{const b=document.querySelector('.file-explorer-body'); const list=document.querySelector('.file-explorer-list'); const r=b.getBoundingClientRect(); const lr=list.getBoundingClientRect(); const y=Math.min(r.bottom-8, lr.bottom+ (r.bottom-lr.bottom)/2); const x=r.x+r.width/2; const hit=document.elementFromPoint(x,y); return {x, y, onEmpty: !hit?.closest('.file-explorer-item, .file-explorer-bar, .file-explorer-crumbs, .file-explorer-menu')}})()`);
if (!emptySpot.onEmpty) console.log('（注意: 空きスペースの位置が項目の上）');
await tap(emptySpot.x, emptySpot.y);
await sleep(150);
expect('空きスペースで選択が解除される（件数に戻る）', (await evalJs(`document.querySelector('.file-explorer-selection-count')?.textContent`)) === '3 件');
expect('選んでいないとき、コピーは押せない', (await evalJs(`document.querySelector('button[aria-label="コピー"]')?.disabled === true`)) === true);
expect('パンくずは上端の下の行にある', (await evalJs(`document.querySelector('.panel-bar')?.nextElementSibling?.classList.contains('file-explorer-crumbs') === true`)) === true);
expect('上端に「閉じる」は無い', (await evalJs(`!document.querySelector('.file-explorer-bar button[aria-label="閉じる"]')`)) === true);

// 未対応の IPC があれば失敗（本体の機能追加で起動時に呼ぶ IPC が増えた退行を、null で隠さない）
const unknownIpc = JSON.parse(await evalJs('JSON.stringify(window.__ipcUnknown)'));
expect('fixture に無い IPC を本体が呼んでいない' + (unknownIpc.length ? `（${unknownIpc.join(', ')}）` : ''), unknownIpc.length === 0);

await S('Target.closeTarget', { targetId }).catch(() => {});
ws.close();
cleanup();
if (failures.length > 0) {
  console.error(`\n押せなかった項目: ${failures.length} 件`);
  process.exit(1);
}
console.log('\n全部押せました');
