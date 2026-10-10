import { SvelteMap } from 'svelte/reactivity';
import type { IconRef } from '../icons.svelte';
import type { Message } from '../protocol/Message';
import { replyTree, type TreeEntry } from '../replyTree';
import { client } from './client.svelte';
import { ui } from './ui.svelte';

/**
 * 「メッセージの集合」を、本体のメッセージ表示のまま、パネル（デスクトップは右、モバイルは全画面）に出す。
 * 本体の返信のツリーと、プラグインの openTimeline が使う。
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
        if (ui.panel?.kind === 'timeline' && ui.panel.id === id) ui.closePanel();
        // パネルがもう出ていない（開く前に別のものに替わった）ときは、ここで片付ける
        else this.release(id);
      },
    };
  }

  /** パネルを片付ける（TimelinePanel が外れたとき）。onClose を1回だけ呼ぶ */
  release(id: number): void {
    const spec = this.specs.get(id);
    if (!spec) return;
    this.specs.delete(id);
    try {
      spec.onClose?.();
    } catch (e) {
      console.error('タイムラインの onClose で例外', e);
    }
  }

  /** メッセージを起点にした返信のツリーを開く。place はそのメッセージのいる場所（スレッドの ID。メインチャットなら null） */
  openReplyTree(message: Pick<Message, 'id'>, place: string | null): TimelineHandle {
    const id = message.id;
    return this.open({
      title: '返信のツリー',
      // 読み込み済みのメッセージから作る。返信は起点より新しいので、起点があれば返信もそろっている
      entries: () => replyTree(client.peekTimeline(place)?.messages ?? [], id),
      empty: 'このメッセージは読み込まれていません。',
    });
  }
}

export const timelinePanels = new TimelinePanels();
