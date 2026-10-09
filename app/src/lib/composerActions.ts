import type { Component } from 'svelte';

/**
 * 入力欄の「＋」メニューの項目。
 * 今は本体の機能だけだが、将来プラグインの composer.action もここに並べる。
 */
export type ComposerAction = {
  id: string;
  label: string;
  icon: Component<{ size?: number }>;
  /** メインチャットでだけ出す、など */
  when?: (ctx: { threadId: string | null }) => boolean;
  run: (ctx: ComposerContext) => void;
};

export type ComposerContext = {
  threadId: string | null;
  pickFiles: () => void;
  toggleStatus: () => void;
};
