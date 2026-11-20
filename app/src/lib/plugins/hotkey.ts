// ホットキーの決まり（Disnans の書き方）。文字・照合・表示は kit の `@3pino/app-kit-web/core/hotkeys` を使い、
// ここではこのアプリの決まり（HOTKEY_OPTIONS）だけを持つ。
//   - Ctrl は `Mod` と書く（プラグインの manifest と、保存される設定の書き方）
//   - Meta（Windows キー）は Ctrl と別のキー
//   - 英字・数字は押した文字でも、キーの位置でも当てる（配列が違っても、画面の文字で決めたものが効く）
//   - `+` は `Plus` と書く
// 保存される値（prefs の hotkeys）は、記録したそのままの書き方を保つ（kit の既定の書き方とは違う）。

import {
  formatHotkey as kitFormat,
  hotkeyFromEvent as kitFromEvent,
  hotkeyFromMouse as kitFromMouse,
  matchesHotkey,
  normalizeHotkey,
  worksWhileTyping as kitWorksWhileTyping,
  type HotkeyOptions,
  type KeyEventLike,
} from '@3pino/app-kit-web/core/hotkeys';

/** このアプリのホットキーの決まり */
export const HOTKEY_OPTIONS: HotkeyOptions = { meta: 'separate', ctrl: 'Mod', letters: 'key-then-code', plus: 'Plus' };

/** 記録しないキーの名前（修飾キーと、変換・デッドキーなど文字にならないもの。小文字で比べる） */
const NOT_RECORDED = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'fn', 'fnlock', 'hyper', 'super', 'dead', 'process', 'unidentified']);

/** 押したキーを、保存・照合の文字にする（修飾キーだけ・変換中・記録しないキーは null） */
export function hotkeyFromEvent(e: KeyEventLike): string | null {
  if (NOT_RECORDED.has(e.key.toLowerCase())) return null;
  return kitFromEvent(e, HOTKEY_OPTIONS);
}

/** マウスの戻る・進む（Mouse4・Mouse5）。このアプリは記録しない（設定の画面で mouse: false） */
export function hotkeyFromMouseEvent(e: Parameters<typeof kitFromMouse>[0]): string | null {
  return kitFromMouse(e, HOTKEY_OPTIONS);
}

/** 書かれたホットキーを読める形にそろえたもの（比べる・重なりを見るのに使う）。読めなければ null */
export function hotkeyId(text: string): string | null {
  return normalizeHotkey(text, HOTKEY_OPTIONS);
}

/** 読めるホットキーか（プラグインの manifest の検査に使う） */
export function readableHotkey(text: string): boolean {
  return hotkeyId(text) !== null;
}

/** 画面に出す形（`Mod+Shift+D` → `Ctrl+Shift+D`。書き方のそろわないもの（`f5`）も、そろえてから出す。読めなければそのまま） */
export function formatHotkey(text: string): string {
  return kitFormat(hotkeyId(text) ?? text);
}

/** イベントが、いずれかのホットキーに当たるか */
export function matchesHotkeyEvent(e: KeyEventLike, keys: readonly string[]): boolean {
  return matchesHotkey(e, keys, HOTKEY_OPTIONS);
}

/** 入力欄で文字を打っている間も働かせてよいか（Ctrl・Alt・Meta のあるもの、F1〜F24） */
export function worksWhileTyping(text: string): boolean {
  return kitWorksWhileTyping(text, { ...HOTKEY_OPTIONS, functionKeys: true });
}
