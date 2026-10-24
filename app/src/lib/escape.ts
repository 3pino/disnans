// Esc で閉じる順番の決まり。開いている上のもの（メニュー・ダイアログ・拡大表示・確認・補完の候補）を先に閉じ、
// 何も開いていないときだけ、そのパネルを閉じる。

/** Esc を、いま開いているパネルが受け取るべきか。上に別の操作（メニュー・ダイアログ・拡大・確認・候補）があれば false */
export function escapeClosesPanel(o: {
  /** 既に処理された（入力欄の候補・検索などが Esc を使った） */
  defaultPrevented: boolean;
  /** 上に開いているものがあるか（DOM の見た目の要素の有無） */
  overlayOpen: boolean;
}): boolean {
  return !o.defaultPrevented && !o.overlayOpen;
}

/** 上に開いているもの（ダイアログ・メニュー・候補の一覧・拡大表示・確認）が、画面にあるか */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], .menu-backdrop, .suggest-list, .lightbox, .confirm-dialog, .modal-scrim';
