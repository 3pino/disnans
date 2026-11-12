// 開発用の検査スクリプトが共有する、Chromium（chrome-headless-shell）の起動と CDP の送受信。
// 実行ファイルの探し方: 環境変数 CHROME_BIN（旧名 CHROME も可）→ puppeteer のキャッシュの一番新しい版。
// 本体のコードも製品の挙動も変えない。タイムアウトは各送信ごとに持つ（既定 15 秒）。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(homedir(), '.cache/puppeteer/chrome-headless-shell');
const BINARY = join('chrome-headless-shell-linux64', 'chrome-headless-shell');

/** Chromium の実行ファイル。見つからなければ、何を設定すればよいかを示して失敗する */
export function chromePath() {
  const fromEnv = process.env.CHROME_BIN ?? process.env.CHROME;
  if (fromEnv) return fromEnv;
  if (existsSync(CACHE)) {
    // 版の名前（例 linux-146.0.7680.153）は辞書順の一番後ろを新しい版として使う
    const found = readdirSync(CACHE).sort().reverse().map((d) => join(CACHE, d, BINARY)).find((p) => existsSync(p));
    if (found) return found;
  }
  throw new Error('Chromium が見つかりません。CHROME_BIN に chrome-headless-shell の実行ファイルを指定してください');
}

/** 使い捨てのプロファイル（終わったら stopChrome で消す） */
export function makeProfile(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Chromium を起動し、DevTools の接続先（ws://）が出るまで待つ。`endpoint` は Promise */
export function launchChrome(profile, { timeoutMs = 15_000 } = {}) {
  const child = spawn(chromePath(), ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium startup timed out')), timeoutMs);
    let text = '';
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { child, endpoint };
}

/** ブラウザーの WebSocket に接続する。`send(method, params, sessionId, ms)` は応答が来ないと失敗する */
export async function connectCdp(endpoint, { timeoutMs = 15_000 } = {}) {
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    for (const listener of listeners) listener(message);
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    clearTimeout(slot.timer);
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
    else slot.resolve(message.result);
  });
  const send = (method, params = {}, sessionId, ms = timeoutMs) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, ms);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return {
    send,
    /** すべての受信（応答とイベント）を見る。デバッグ用 */
    onMessage: (listener) => listeners.push(listener),
    close: () => ws.close(),
  };
}

/** 新しいページを作って接続し、そのページ向けの送信関数を返す */
export async function openPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return (method, params) => cdp.send(method, params, sessionId);
}

/** ページで式を評価して値を返す。例外は詳細つきで失敗する */
export async function evaluate(page, expression) {
  const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('評価に失敗: ' + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** Chromium を止め、プロファイルを消す */
export function stopChrome(child, profile) {
  child?.kill();
  if (profile) rmSync(profile, { recursive: true, force: true });
}
