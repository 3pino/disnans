import { SvelteMap } from 'svelte/reactivity';
import { client } from './client.svelte';
import { uniqueViewers } from '../presence';

/**
 * セッションを開いている人（session.presence）の一覧。カードに、開いている人のアイコンを出すのに使う。
 * 本体の表示用。プラグインには、同じ情報を session.viewers として渡す（lib/plugins）。
 */
class Presence {
  private byId = new SvelteMap<string, string[]>();
  private started = false;

  /** そのセッションを開いている人（自分を含む）。いなければ空 */
  viewers(sessionId: string): string[] {
    return this.byId.get(sessionId) ?? [];
  }

  apply(sessionId: string, viewers: readonly string[]): void {
    const ids = uniqueViewers(viewers);
    if (ids.length === 0) this.byId.delete(sessionId);
    else this.byId.set(sessionId, ids);
  }

  /** 接続のイベントを受け始める（1回だけ） */
  start(): void {
    if (this.started) return;
    this.started = true;
    client.subscribe((ev) => {
      if (ev.type === 'session.presence') this.apply(ev.session_id, ev.user_ids);
    });
  }
}

export const presence = new Presence();
