// 端末の判定（ステップ7・P2）。
// Tauri では Rust が `window.__DISNANS_PLATFORM__`（app/src-tauri/src/platform.rs）に端末の事実を入れる。
// その値が正しい形で有れば、それを使う（UA 文字列を見ない）。無い・壊れているときは、いままでどおり UA で判断する（安全側）。
// ブラウザー（Tauri でない）は Rust が無いので、常に UA で判断する。
// ここに判定を集める。呼び出し側は config.ts（再エクスポート）か、ここの関数を直接使う。

/** Rust が入れる端末の事実（JSON は camelCase。platform.rs の PlatformInfo と揃える） */
export type InjectedPlatform = {
  /** "windows" | "linux" | "macos" | "android" | "ios" | "other" */
  os: string;
  /** デスクトップの Tauri か（windows・linux・macos） */
  desktop: boolean;
  /** Android の Tauri か */
  android: boolean;
};

type WithInjected = { __DISNANS_PLATFORM__?: unknown };

/** Rust が入れた端末の事実。無い・形が違うときは null（呼び出し側は UA で判断する） */
export function injectedPlatform(): InjectedPlatform | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as WithInjected).__DISNANS_PLATFORM__;
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.os !== 'string' || typeof v.desktop !== 'boolean' || typeof v.android !== 'boolean') return null;
  return { os: v.os, desktop: v.desktop, android: v.android };
}

/** Tauri の中か（WebView の内部オブジェクトの有無） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Android か（Tauri でもブラウザーでも）。Rust の値があればそれ、無ければ UA */
export function isAndroid(): boolean {
  const info = injectedPlatform();
  if (info) return info.android;
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

/** Linux の Tauri 版（WebKitGTK）。ファイルのドロップとクリップボードの画像の扱いが他と違う */
export function isLinuxDesktop(): boolean {
  if (!isTauri() || isAndroid()) return false;
  const info = injectedPlatform();
  if (info) return info.os === 'linux';
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent);
}

/** Mac か（キーの表記。Cmd と Ctrl の扱い）。iPhone・iPad も含める（従来どおり） */
export function isMacLike(): boolean {
  const info = injectedPlatform();
  if (info) return info.os === 'macos' || info.os === 'ios';
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}
