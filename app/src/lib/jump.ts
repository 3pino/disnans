import { tick } from 'svelte';
import type { Timeline } from './stores/timeline.svelte';
import { ui } from './stores/ui.svelte';

/** 古いページを取りに行く回数の上限（かなり古い返信先でも、無限には探さない） */
const MAX_PAGES = 20;
/** 強調を残す時間（ms） */
const FLASH_MS = 1800;

/**
 * `from`（返信の引用など）と同じメッセージ一覧の中で、`id` のメッセージまでスクロールして、しばらく強調する。
 * 読み込まれていなければ、見つかるまで古いページを読み込む。見つからなければトーストを出す
 */
export async function jumpToMessage(from: HTMLElement, timeline: Timeline, id: string): Promise<void> {
  const scroller = from.closest<HTMLElement>('.message-list-scroller');
  if (!scroller) return;
  const find = () => scroller.querySelector<HTMLElement>(`.message-item[data-id="${CSS.escape(id)}"]`);

  let el = find();
  for (let i = 0; !el && i < MAX_PAGES && timeline.hasMore; i++) {
    const before = timeline.messages.length;
    await timeline.loadOlder();
    await tick();
    el = find();
    if (timeline.messages.length === before) break; // 取れなかった（読み込み中・失敗）
  }
  if (!el) {
    ui.toast('元のメッセージを表示できませんでした');
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('message-item-flash');
  // アニメーションをやり直すため、再描画を挟んでから付ける
  void el.offsetWidth;
  el.classList.add('message-item-flash');
  const target = el;
  setTimeout(() => target.classList.remove('message-item-flash'), FLASH_MS);
}
