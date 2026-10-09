/**
 * 文字列をクリップボードに書き込む。成功したら true。
 * Tauri の画面（tauri://localhost、https://tauri.localhost、Android の http://tauri.localhost）は
 * どれも安全なコンテキストなので、ふつうは navigator.clipboard で書ける。
 * 古い WebView などで使えないときは、隠した textarea を選択して execCommand('copy') で書く。
 * どちらもタップやクリックの処理の中から呼ぶこと（ユーザー操作が無いと拒否される）
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 下のやり方で試す
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  // 画面には出さない。readonly なので Android でもキーボードは出ない
  el.style.position = 'fixed';
  el.style.top = '0';
  el.style.left = '0';
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  el.remove();
  prev?.focus({ preventScroll: true });
  return ok;
}
