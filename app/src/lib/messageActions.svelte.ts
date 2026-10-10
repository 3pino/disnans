import type { IconRef } from './icons.svelte';
import type { Message } from './protocol/Message';
import { SvelteMap } from 'svelte/reactivity';

/**
 * メッセージの操作の項目。メッセージを長押ししたときのメニュー（モバイルの ActionSheet）と、
 * デスクトップでホバーしたときのツールバーに並べる。本体の項目（返信・編集・削除など）も、
 * registerMessageAction で登録されたもの（プラグインの addMessageAction）も同じ仕組みで並べる
 */

/** 項目を出す場所。menu は長押しのメニュー、toolbar はホバーのツールバー */
export type MessageActionPlacement = 'menu' | 'toolbar' | 'both';

/** 項目を出すかどうか・実行するときに渡す、メッセージのいる場所 */
export type MessageActionContext = {
  message: Message;
  /** スレッドのパネルの中（起点のメッセージを含む）で見ているか */
  inThread: boolean;
  /** 返信を送る場所（スレッドの ID。メインチャットなら null） */
  place: string | null;
};

/** 実行するときだけ渡すもの */
export type MessageActionRunContext = MessageActionContext & {
  /** 押した場所（絵文字ピッカーなどを出す位置） */
  anchor: DOMRect;
  /** 絵文字ピッカーを anchor のそばに開く（選んだ絵文字はリアクションになる） */
  openPicker(anchor: DOMRect): void;
};

export type MessageAction = {
  id: string;
  label: string | ((ctx: MessageActionContext) => string);
  /** アイコン（Svelte の部品か、アイコンの名前: lib/icons.svelte.ts）。無ければ既定のアイコン（Puzzle） */
  icon?: IconRef;
  placement: MessageActionPlacement;
  /** 削除など、注意の色にする */
  danger?: boolean;
  /** 並び順（小さいほど前）。同じなら登録した順。本体の項目は 100 刻み、既定は 1000、削除は 9000 */
  order?: number;
  /** このメッセージに出すか（省くと常に出す） */
  when?: (ctx: MessageActionContext) => boolean;
  run: (ctx: MessageActionRunContext) => void | Promise<void>;
  /** 出どころ（プラグイン名など）。本体の項目は省略 */
  source?: string;
};

/** 並べて出す1項目 */
export type ResolvedMessageAction = {
  id: string;
  label: string;
  icon?: IconRef;
  danger: boolean;
  source?: string;
  run: (anchor: DOMRect, openPicker: (anchor: DOMRect) => void) => void | Promise<void>;
};

/** プラグインの項目の既定の並び順 */
export const DEFAULT_ACTION_ORDER = 1000;

let seq = 0;
const registered = new SvelteMap<string, { action: MessageAction; seq: number }>();

/** メッセージの操作に項目を足す。同じ id は後勝ち。返り値の関数で解除する */
export function registerMessageAction(action: MessageAction): () => void {
  registered.delete(action.id);
  const entry = { action, seq: seq++ };
  registered.set(action.id, entry);
  return () => {
    if (registered.get(action.id) === entry) registered.delete(action.id);
  };
}

/** 登録されている項目（リアクティブ）。並び順、同じなら登録した順 */
export function messageActions(): MessageAction[] {
  return [...registered.values()]
    .sort((a, b) => (a.action.order ?? DEFAULT_ACTION_ORDER) - (b.action.order ?? DEFAULT_ACTION_ORDER) || a.seq - b.seq)
    .map((e) => e.action);
}

/**
 * このメッセージに出す項目（placement に合うもの）を並べて返す（リアクティブ）。
 * when / label の例外は握りつぶして、その項目だけ出さない
 */
export function resolveMessageActions(ctx: MessageActionContext, where: 'menu' | 'toolbar'): ResolvedMessageAction[] {
  const out: ResolvedMessageAction[] = [];
  for (const a of messageActions()) {
    if (a.placement !== 'both' && a.placement !== where) continue;
    try {
      if (a.when && !a.when(ctx)) continue;
      const label = typeof a.label === 'function' ? a.label(ctx) : a.label;
      out.push({
        id: a.id,
        label,
        icon: a.icon,
        danger: !!a.danger,
        source: a.source,
        run: (anchor, openPicker) => a.run({ ...ctx, anchor, openPicker }),
      });
    } catch (e) {
      console.error(`[message-action:${a.id}]`, e);
    }
  }
  return out;
}
