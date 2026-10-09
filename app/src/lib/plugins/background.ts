import { isAndroid, isTauri } from '../config';

/**
 * 画面を切っても動き続けるための常駐（API v3 の holdBackground）。
 * Android ではフォアグラウンドサービス（notifier プラグインの call サービス。microphone 型）を動かす。
 * ほかの環境（デスクトップ・ブラウザー）ではウィンドウが裏に回っても動くので、何もしない。
 * 複数のプラグインが同時に頼んでもよいように、数えておき、最後の1つが外れたら止める。
 */
type Held = Disnans.BackgroundOptions;

const held = new Set<Held>();
/** サービスの開始・停止を順番に行う */
let queue: Promise<void> = Promise.resolve();

async function invokeNotifier(cmd: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(`plugin:notifier|${cmd}`, args);
}

function sync(): Promise<void> {
  const run = async () => {
    const last = [...held].pop();
    if (last) {
      await invokeNotifier('start_call', {
        title: last.title ?? '',
        text: last.text ?? '',
        microphone: [...held].some((h) => h.microphone),
      });
    } else {
      await invokeNotifier('stop_call');
    }
  };
  queue = queue.then(run, run);
  return queue;
}

export async function holdBackground(opts: Disnans.BackgroundOptions): Promise<() => void> {
  if (!isTauri() || !isAndroid()) return () => {};
  const entry: Held = { ...opts };
  held.add(entry);
  try {
    await sync();
  } catch (e) {
    held.delete(entry);
    throw e;
  }
  return () => {
    if (!held.delete(entry)) return;
    void sync().catch((e) => console.warn('常駐を止められませんでした', e));
  };
}
