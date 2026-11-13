// 貼り付け・クリップボードの経路の決め方（Android の notifier か、Linux の Tauri のネイティブ、それ以外）。
// 判定は platform.ts が持つ（Rust の注入値を優先）。ここでは 1 回読んだ結果をまとめて返すだけ。
import { isAndroid, isLinuxDesktop } from './platform';

export type PasteSource = {
  /** Android（notifier のクリップボード・カメラの標準アプリ・貼り付けで blur する） */
  android: boolean;
  /** Linux の Tauri（WebKitGTK の画像の貼り付けを、ネイティブのクリップボードで補う） */
  linuxDesktop: boolean;
};

/** 貼り付けの経路。呼ぶたびに読む（起動後は変わらない値）。Android では linuxDesktop は必ず false */
export function pasteSource(): PasteSource {
  const android = isAndroid();
  return { android, linuxDesktop: !android && isLinuxDesktop() };
}
