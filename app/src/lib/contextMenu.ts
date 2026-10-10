/**
 * WebView の右クリックのメニュー（「最新の情報に更新」「名前をつけて保存」「印刷」など）を、document 全体で止める。
 * 入力欄（input・textarea・contenteditable）の中だけは、既定のメニュー（コピー・貼り付けなど）を残す。
 * アプリが自分で contextmenu を使う操作（通話の参加者・メッセージの操作など）は、それぞれの要素で処理するので、ここでは止めるだけ。
 */

/** 入力欄の中か（既定のメニューを残す） */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
}

/** 既定のメニューを止めるか（入力欄の中では止めない） */
export function shouldBlockContextMenu(target: EventTarget | null): boolean {
  return !isEditableTarget(target);
}

export function startContextMenuGuard(): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (shouldBlockContextMenu(e.target)) e.preventDefault();
  };
  document.addEventListener('contextmenu', onContextMenu);
  return () => document.removeEventListener('contextmenu', onContextMenu);
}
