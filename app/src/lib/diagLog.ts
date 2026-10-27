// 診断ログ。「通知が来ない」「通話が切れる」など、開発者の環境で再現しない不具合を調べるための記録。
// console の info / warn / error と、画面の表示・回線・捕まえていないエラーを残す。設定の「診断ログ」から書き出して送ってもらう。
// - Android: 行を notifier プラグインに送り、ネイティブ（常駐サービス・通話のサービス）の記録と同じファイルに時刻順に残す
// - それ以外: localStorage に残す（再読み込みしても消えない。上限を超えたら古い行から捨てる）
// メッセージの本文は書かないこと（送ってもらう前提なので、ログには ID や状態だけを書く）

import { isAndroid, isTauri, userAgentForLog } from './platform';

const NOTIFIER = 'plugin:notifier|';
const STORAGE_KEY = 'disnans.diagLog';
const MAX_LINES = 3000;
const MAX_LINE_CHARS = 1000;
const SAVE_DELAY_MS = 2000;

type Level = 'info' | 'warn' | 'error';

let lines: string[] = [];
let installed = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function native(): boolean {
  return isTauri() && isAndroid();
}

async function invokeNotifier<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`${NOTIFIER}${cmd}`, args);
}

function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** ネイティブの行と同じ形の時刻（MM-dd HH:mm:ss.SSS、デバイスの時刻） */
function stamp(d = new Date()): string {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? raw.split('\n').filter((l) => l !== '') : [];
  } catch {
    return [];
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flushDiagLog, SAVE_DELAY_MS);
}

/** 溜まった行を localStorage に書く（Android はネイティブが持つので何もしない） */
export function flushDiagLog(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (native()) return;
  try {
    localStorage.setItem(STORAGE_KEY, lines.join('\n'));
  } catch {
    // 容量が足りないときは、古い半分を捨ててもう一度だけ試す
    lines = lines.slice(Math.floor(lines.length / 2));
    try {
      localStorage.setItem(STORAGE_KEY, lines.join('\n'));
    } catch {
      // 残せなくても本体の動作は続ける
    }
  }
}

/** 1 行を残す。console を通さずに記録したいとき（画面の出来事など）に使う */
export function diagLog(level: Level, message: string): void {
  const text = message.replace(/\n/g, ' ').slice(0, MAX_LINE_CHARS);
  if (native()) {
    invokeNotifier('diag_log', { level, message: text }).catch(() => {});
    return;
  }
  lines.push(`${stamp()} ${level === 'error' ? 'E' : level === 'warn' ? 'W' : 'I'} ${text}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  scheduleSave();
}

/**
 * console の info / warn / error を診断ログにも残し、画面の表示・回線・エラーの出来事を記録する。
 * 起動の最初に 1 回だけ呼ぶ。元の console の出力はそのまま残す。
 */
export function installDiagLog(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (!native()) lines = load();

  for (const level of ['info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        diagLog(level, args.map(describe).join(' '));
      } catch {
        // 記録に失敗しても console は使えるままにする
      }
    };
  }

  window.addEventListener('error', (e) => {
    diagLog('error', `[error] ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    diagLog('error', `[error] 捕まえていない reject: ${describe(e.reason)}`);
  });
  document.addEventListener('visibilitychange', () => {
    diagLog('info', `[page] visibility=${document.visibilityState}`);
    // 裏に回ったまま止められても残るよう、すぐ書く
    if (document.visibilityState === 'hidden') flushDiagLog();
  });
  // Page Lifecycle（Chromium）。裏で凍結されたかが分かる
  document.addEventListener('freeze', () => diagLog('info', '[page] freeze'));
  document.addEventListener('resume', () => diagLog('info', '[page] resume'));
  window.addEventListener('pagehide', (e) => {
    diagLog('info', `[page] pagehide persisted=${e.persisted}`);
    flushDiagLog();
  });
  window.addEventListener('online', () => diagLog('info', '[page] online'));
  window.addEventListener('offline', () => diagLog('info', '[page] offline'));

  diagLog('info', `[page] 読み込みました: ${userAgentForLog()}`);
}

/** 残っている行を消す */
export async function clearDiagLog(): Promise<void> {
  lines = [];
  if (native()) {
    await invokeNotifier('diag_clear');
    return;
  }
  flushDiagLog();
}

/** 書き出す全文。context は先頭に載せる項目（版・サーバー・通知の状態など） */
export async function buildDiagReport(context: [string, string][]): Promise<string> {
  const out: string[] = ['disnans 診断ログ', `作成: ${new Date().toString()}`];
  for (const [name, value] of context) out.push(`${name}: ${value}`);
  out.push(`UA: ${userAgentForLog()}`);
  out.push(`画面: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`);
  if (native()) {
    const r = await invokeNotifier<{ device: string; log: string }>('diag_read');
    out.push('', '---- デバイス ----', r.device, '', '---- ログ（古い順） ----', r.log.trimEnd());
  } else {
    flushDiagLog();
    out.push('', '---- ログ（古い順） ----', ...lines);
  }
  return out.join('\n') + '\n';
}

/** 書き出すファイルの名前（disnans-log-YYYYMMDD-HHMMSS.txt） */
export function diagFileName(d = new Date()): string {
  return `disnans-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}

/**
 * テキストファイルにして渡す。Android は共有のシート（メール・チャットなどを選ぶ）、それ以外はダウンロード。
 * true なら共有のシートを開いた（ダウンロードは false）
 */
export async function exportDiagReport(text: string): Promise<boolean> {
  const name = diagFileName();
  if (native()) {
    await invokeNotifier('diag_share', { text, name });
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return false;
}

/** テスト用: 状態を最初に戻す */
export function resetDiagLogForTest(): void {
  lines = [];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}
