/**
 * バイト列の本体の渡し方（契約 §9.3 / §10.1 の Android 補足）。
 * デスクトップは raw body（Uint8Array）。Android は Tauri の IPC が raw body を渡せない
 * （Rust 側は常に JSON で受ける）ので、base64 の文字列を JSON の値として渡す。
 */
export type BodyMode = 'raw' | 'base64';

/** バイト列を base64 にする。大きい入力でもスタックを溢れさせないよう分割して連結する */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

/** 本体を IPC の引数にする（raw ならそのまま、base64 なら文字列） */
export function encodeBody(bytes: Uint8Array, mode: BodyMode): Uint8Array | string {
  return mode === 'base64' ? bytesToBase64(bytes) : bytes;
}
