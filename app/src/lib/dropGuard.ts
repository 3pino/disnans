/**
 * ファイルをドロップしたときに、WebView がそのファイルへ移動してしまう（画像を全画面で開く）のを
 * document 全体で止める。受け取りは ChatView が行うので、ここでは既定の動作だけを止める。
 * 文字（テキストやリンク）を入力欄へ入れる既定の動きは残す（ファイルのパスは、ここで止める）。
 */

/** ファイルのドロップか（ファイル本体、またはファイルの URI。Linux の file manager はこちら） */
function isFileDrag(e: DragEvent): boolean {
  const types = [...(e.dataTransfer?.types ?? [])];
  return types.includes('Files') || types.includes('text/uri-list');
}

/** 入力欄の上へのリンク（URI）のドロップは、ふつうに文字として入れる */
function shouldBlock(e: DragEvent): boolean {
  if (!isFileDrag(e)) return false;
  const types = [...(e.dataTransfer?.types ?? [])];
  if (types.includes('Files')) return true;
  const target = e.target instanceof Element ? e.target : null;
  return !target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
}

export function startDropGuard(): () => void {
  const onDragOver = (e: DragEvent) => {
    if (shouldBlock(e)) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (shouldBlock(e)) e.preventDefault();
  };
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  return () => {
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('drop', onDrop);
  };
}
