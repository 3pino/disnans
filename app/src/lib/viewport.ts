// 画面の高さと拡大まわり。
// - キーボードを出すと、見えている高さ（visualViewport）が縮む。アプリの高さを、その見えている高さに合わせる。
//   そうしないと入力欄が画面の外へ押し出され、ブラウザーが画面全体をずらしてしまう
// - ピンチ・Ctrl+ホイール・Ctrl+±/0 による拡大は止める（ページ全体が動くのを防ぐ）

export const APP_HEIGHT_VAR = '--app-height';

type VisualViewportLike = Pick<VisualViewport, 'height' | 'addEventListener' | 'removeEventListener'>;

/** Ctrl（Mac は Cmd）を押しながらのホイール。トラックパッドのピンチもこれで届く */
export function isZoomWheel(e: Pick<WheelEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return e.ctrlKey || e.metaKey;
}

/** 拡大・縮小・等倍のキー（Ctrl or Cmd と + - = 0。テンキーの Add・Subtract も含む） */
export function isZoomKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return ['+', '=', '-', '_', '0', 'Add', 'Subtract'].includes(e.key);
}

/** アプリの高さ（--app-height）を、見えている高さに合わせる。止める関数を返す */
export function startViewportSync(
  root: HTMLElement = document.documentElement,
  vv: VisualViewportLike | null = window.visualViewport ?? null,
  w: Pick<Window, 'addEventListener' | 'removeEventListener' | 'innerHeight'> = window,
): () => void {
  const apply = () => {
    const h = vv ? vv.height : w.innerHeight;
    if (h > 0) root.style.setProperty(APP_HEIGHT_VAR, `${Math.round(h)}px`);
  };
  apply();
  vv?.addEventListener('resize', apply);
  w.addEventListener('resize', apply);
  return () => {
    vv?.removeEventListener('resize', apply);
    w.removeEventListener('resize', apply);
    root.style.removeProperty(APP_HEIGHT_VAR);
  };
}

/** 拡大の操作を止める。止める関数を返す */
export function startZoomGuard(w: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onWheel = (e: WheelEvent) => {
    if (isZoomWheel(e)) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent) => {
    if (isZoomKey(e)) e.preventDefault();
  };
  w.addEventListener('wheel', onWheel, { passive: false, capture: true });
  w.addEventListener('keydown', onKey, { capture: true });
  return () => {
    w.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    w.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  };
}
