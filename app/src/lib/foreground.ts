/**
 * ウィンドウに戻ったとき（フォーカス・表示になったとき）に fn を呼ぶ。
 * CLI など別の口で変えられた設定を読み直すために使う（読み直しの間引きは各 store の側で行う）。
 * 返り値で外せる。
 */
export function onForeground(fn: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'visible') fn();
  };
  window.addEventListener('focus', fn);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('focus', fn);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
