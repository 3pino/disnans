/**
 * Android の画面の向き（端末ごとの設定）。
 * portrait: 向きを固定（縦）。media: 全画面のメディア（写真・没入モードの画面共有）を見ている間だけ自動回転、それ以外は縦。
 * auto: 自動回転（従来どおり）
 */
export type OrientationMode = 'portrait' | 'media' | 'auto';

export const ORIENTATION_MODES: readonly OrientationMode[] = ['portrait', 'media', 'auto'];
export const DEFAULT_ORIENTATION: OrientationMode = 'auto';

/** 端末ごとの保存先（今は localStorage。後で端末の設定へ移す） */
export const ORIENTATION_KEY = 'disnans.orientation';

/** 読めない値は既定（自動回転） */
export function normalizeOrientationMode(raw: unknown): OrientationMode {
  return (ORIENTATION_MODES as readonly unknown[]).includes(raw) ? (raw as OrientationMode) : DEFAULT_ORIENTATION;
}

/** ネイティブへ渡す向きの固定の状態 */
export type OrientationLock = 'portrait' | 'unlocked';

/** 設定と全画面かどうかから、向きの固定の状態を決める（純粋関数） */
export function orientationLock(mode: OrientationMode, mediaFullscreen: boolean): OrientationLock {
  if (mode === 'auto') return 'unlocked';
  if (mode === 'portrait') return 'portrait';
  return mediaFullscreen ? 'unlocked' : 'portrait';
}

/** ネイティブ（setScreenOrientation）へ渡す値。portrait=縦固定、user=システムに従う */
export function nativeOrientation(lock: OrientationLock): 'portrait' | 'user' {
  return lock === 'portrait' ? 'portrait' : 'user';
}
