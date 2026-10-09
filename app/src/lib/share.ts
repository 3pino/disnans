import { isAndroid, isTauri } from './config';
import { shareInbox } from './stores/shareInbox.svelte';
import { ui } from './stores/ui.svelte';

/**
 * 他のアプリの「共有」から disnans に渡されたファイル・テキストを受け取る（Android）。
 * notifier プラグインが content:// のファイルをアプリのキャッシュにコピーし、名前・MIME・パスだけを渡してくる。
 * 中身は専用のコマンド（read_shared_file）でバイナリのまま読み、File にして shareInbox に積む。
 * アプリを共有で起こしたとき（コールドスタート）は take_shared で、起動中に共有されたときは share イベントで受け取る。
 */

type SharedFile = { path: string; name: string; mime: string; size: number };
type Share = { files?: SharedFile[]; text?: string; errors?: string[] };

async function toFile(f: SharedFile): Promise<File> {
  const { invoke } = await import('@tauri-apps/api/core');
  const buf = await invoke<ArrayBuffer>('read_shared_file', { path: f.path });
  return new File([buf], f.name, { type: f.mime });
}

async function receive(share: Share): Promise<void> {
  for (const err of share.errors ?? []) ui.toast(`共有を受け取れませんでした（${err}）`, 'error');
  const files: File[] = [];
  for (const f of share.files ?? []) {
    try {
      files.push(await toFile(f));
    } catch (e) {
      ui.toast(`共有を受け取れませんでした（${f.name}: ${e instanceof Error ? e.message : String(e)}）`, 'error');
    }
  }
  if (files.length === 0 && !share.text) return;
  // メインチャットの入力欄に入るので、開いているスレッドや設定は閉じてチャットを見せる
  ui.tab = 'chat';
  ui.panel = null;
  ui.pluginSettings = null;
  shareInbox.push(files, share.text);
}

let started = false;

/** アプリの起動時に1回呼ぶ。Android 以外では何もしない */
export async function startShareReceiver(): Promise<void> {
  if (started || !isTauri() || !isAndroid()) return;
  started = true;
  try {
    const { addPluginListener, invoke } = await import('@tauri-apps/api/core');
    await addPluginListener<Share>('notifier', 'share', (s) => void receive(s));
    const { shares } = await invoke<{ shares?: Share[] }>('plugin:notifier|take_shared');
    for (const s of shares ?? []) await receive(s);
  } catch (e) {
    started = false;
    console.warn('共有の受け取りを始められませんでした', e);
  }
}
