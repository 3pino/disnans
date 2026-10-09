import type { Component } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

/**
 * 入力欄の「＋」メニューの項目。
 * 本体の「ファイルを添付」と、registerComposerAction で登録されたもの（プラグインの addComposerAction など）を並べる
 */
export type ComposerAction = {
  id: string;
  label: string;
  /** アイコン。icon も iconSvg も無ければ既定のアイコン（Puzzle） */
  icon?: Component<{ size?: number }>;
  /** プラグイン用の SVG 文字列。{@html} で描く */
  iconSvg?: string;
  /** メインチャットでだけ出す、など */
  when?: (ctx: { threadId: string | null }) => boolean;
  run: (ctx: { threadId: string | null }) => void | Promise<void>;
  /** 出どころ（プラグイン名など）。本体の項目は省略 */
  source?: string;
};

/** 本体の項目にだけ渡す操作 */
export type ComposerContext = {
  threadId: string | null;
  pickFiles: () => void;
};

/** 本体の項目。run には ComposerContext を渡す */
export type BuiltinComposerAction = Omit<ComposerAction, 'run'> & { run: (ctx: ComposerContext) => void };

const registered = new SvelteMap<string, ComposerAction>();

/** 登録されている項目（リアクティブ）。登録した順 */
export function composerActions(): ComposerAction[] {
  return [...registered.values()];
}

/** 「＋」メニューに項目を足す。同じ id は後勝ち。返り値の関数で解除する */
export function registerComposerAction(action: ComposerAction): () => void {
  registered.delete(action.id);
  registered.set(action.id, action);
  return () => {
    if (registered.get(action.id) === action) registered.delete(action.id);
  };
}
