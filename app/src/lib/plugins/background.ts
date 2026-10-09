import { isAndroid, isTauri } from '../config';

/**
 * 画面を切っても動き続けるための常駐（API v3 の holdBackground）。
 * Android ではフォアグラウンドサービス（notifier プラグインの call サービス。microphone 型）を動かす。
 * ほかの環境（デスクトップ・ブラウザー）ではウィンドウが裏に回っても動くので、何もしない。
 * 複数のプラグインが同時に頼んでもよいように、数えておき、最後の1つが外れたら止める。
 */
type Held = Disnans.BackgroundOptions;

/** 通知のボタンが押されたときのイベント名（notifier プラグインの trigger("call_action")） */
const ACTION_EVENT = 'call_action';
let listening: Promise<void> | null = null;

const held = new Set<Held>();
/** サービスの開始・停止を順番に行う */
let queue: Promise<void> = Promise.resolve();

async function invokeNotifier(cmd: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(`plugin:notifier|${cmd}`, args);
}

/** 通知のボタンは、いま通知に出ている（最後に頼んだ）プラグインの onAction に届ける */
function dispatchAction(id: string): void {
  const target = [...held].pop();
  if (!target?.onAction) return;
  if (!target.actions?.some((a) => a.id === id)) return;
  try {
    target.onAction(id);
  } catch (e) {
    console.error('通知のボタンの処理で例外', e);
  }
}

/**
 * 通知のボタンを受け取る準備。リスナーを付けたあと、WebView が止まっていて届かなかった分も受け取る。
 * 失敗したら次の holdBackground でやり直す
 */
function ensureListener(): Promise<void> {
  if (!listening) {
    listening = (async () => {
      const { addPluginListener } = await import('@tauri-apps/api/core');
      await addPluginListener<{ id: string }>('notifier', ACTION_EVENT, (e) => dispatchAction(e.id));
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ ids?: string[] }>('plugin:notifier|take_call_actions');
      for (const id of res?.ids ?? []) dispatchAction(id);
    })().catch((e) => {
      listening = null;
      console.warn('通話の通知のボタンを受け取れません', e);
    });
  }
  return listening;
}

function sync(): Promise<void> {
  const run = async () => {
    const last = [...held].pop();
    if (last) {
      await invokeNotifier('start_call', {
        title: last.title ?? '',
        text: last.text ?? '',
        microphone: [...held].some((h) => h.microphone),
        actions: (last.actions ?? []).slice(0, 3).map((a) => ({ id: a.id, title: a.title, dismiss: a.dismiss ?? false })),
      });
    } else {
      await invokeNotifier('stop_call');
    }
  };
  queue = queue.then(run, run);
  return queue;
}

export async function holdBackground(opts: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle> {
  if (!isTauri() || !isAndroid()) return Object.assign(() => {}, { update: () => {} });
  const entry: Held = { ...opts };
  held.add(entry);
  try {
    if (entry.actions?.length) await ensureListener();
    await sync();
  } catch (e) {
    held.delete(entry);
    throw e;
  }
  const release = () => {
    if (!held.delete(entry)) return;
    void sync().catch((e) => console.warn('常駐を止められませんでした', e));
  };
  const update = (patch: Disnans.BackgroundUpdate) => {
    if (!held.has(entry)) return;
    if (patch.title !== undefined) entry.title = patch.title;
    if (patch.text !== undefined) entry.text = patch.text;
    if (patch.actions !== undefined) entry.actions = patch.actions;
    void (entry.actions?.length ? ensureListener() : Promise.resolve())
      .then(() => sync())
      .catch((e) => console.warn('通知を更新できませんでした', e));
  };
  return Object.assign(release, { update });
}
