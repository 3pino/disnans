import { SvelteMap } from 'svelte/reactivity';
import type { IconRef } from '../icons.svelte';
import type { Message } from '../protocol/Message';
import { replyTree, type TreeEntry } from '../replyTree';
import { client } from './client.svelte';
import { ui } from './ui.svelte';

/**
 * 「メッセージの集合」を、本体のメッセージ表示のまま、パネル（デスクトップは右、モバイルは全画面）に出す。
 * プラグインの openTimeline が使う（本体の返信のツリーも同じ表示。こちらは id を持たず replyTreeSpec で中身を作る）。
 * 並びは entries が決める（呼び出しのたびに最新を返す。リアクティブな値を読めば、変わったときに描き直される）
 */
export type TimelineEntry = TreeEntry;

export type TimelineSpec = {
  title: string;
  /** 題名の横のアイコン（省略するとメッセージのアイコン） */
  icon?: IconRef;
  entries: () => TimelineEntry[];
  /** 空のときの文言 */
  empty?: string;
  /** パネルが閉じたとき（別のパネルに替わったときを含む）に1回だけ呼ぶ */
  onClose?: () => void;
};

export type TimelineHandle = {
  /** 題名・アイコン・中身・空の文言を差し替える */
  update(patch: Partial<Omit<TimelineSpec, 'onClose'>>): void;
  /** 閉じる（何度呼んでもよい） */
  close(): void;
};

class TimelinePanels {
  private specs = new SvelteMap<number, TimelineSpec>();
  private seq = 0;

  get(id: number): TimelineSpec | undefined {
    return this.specs.get(id);
  }

  /** パネルに開く */
  open(spec: TimelineSpec): TimelineHandle {
    const id = ++this.seq;
    this.specs.set(id, { ...spec });
    ui.openTimeline(id);
    return {
      update: (patch) => {
        const cur = this.specs.get(id);
        if (cur) this.specs.set(id, { ...cur, ...patch });
      },
      close: () => {
        const shown = ui.panel?.kind === 'timeline' && ui.panel.id === id;
        // 開いていれば閉じ（片付けは TimelinePanel が外れたとき）、遷移の履歴からも外す
        ui.forgetPanel((p) => p.kind === 'timeline' && p.id === id);
        // パネルがもう出ていない（開く前に別のものに替わった）ときは、ここで片付ける
        if (!shown) this.release(id);
      },
    };
  }

  /**
   * パネルを片付ける（TimelinePanel が外れたとき）。onClose を1回だけ呼ぶ。
   * 中身はもう引けないので、遷移の履歴からも外す（戻る操作で空のパネルを開き直さない）
   */
  release(id: number): void {
    const spec = this.specs.get(id);
    if (!spec) return;
    this.specs.delete(id);
    ui.forgetPanel((p) => p.kind === 'timeline' && p.id === id);
    try {
      spec.onClose?.();
    } catch (e) {
      console.error('タイムラインの onClose で例外', e);
    }
  }

  /**
   * メッセージを起点にした返信のツリーを開く。
   * パネルは { kind: 'replyTree' } で、中身（replyTreeSpec）はその場で作る。戻る操作で開き直せるよう、ID の発行や後片付けは要らない
   */
  openReplyTree(message: Pick<Message, 'id'>): void {
    ui.openReplyTree(message.id);
  }

  /** 返信のツリーの中身 */
  replyTreeSpec(messageId: string): TimelineSpec {
    return {
      title: '返信のツリー',
      // 読み込み済みのメッセージから作る。返信は起点より新しいので、起点があれば返信もそろっている
      entries: () => replyTree(client.timeline().messages, messageId),
      empty: 'このメッセージは読み込まれていません。',
    };
  }
}

export const timelinePanels = new TimelinePanels();
