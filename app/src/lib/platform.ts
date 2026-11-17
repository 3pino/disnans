// デバイスの判定（ステップ7）。OS の判定の土台は @3pino/app-kit-web/core/platform（汎用）。
// ここは disnans の方針（capabilities）だけを持つ。
// Tauri では Rust が `window.__DISNANS_PLATFORM__`（app/src-tauri/src/platform.rs）にデバイスの事実と方針を入れる。
// 値が正しい形で有れば、それを使う（UA 文字列を見ない）。無い・壊れている項目は、従来どおり UA などから推測する（安全側）。
// 呼び出し側は capabilities() か、個別の関数（isTauri など）を使う。
import './platformGlobal';
import { injectedPlatform, isAndroid, isDesktopWindowsOrLinuxTauri, isLinuxDesktop, isTauri } from '@3pino/app-kit-web/core/platform';

export * from '@3pino/app-kit-web/core/platform';

/** このデバイスでの方針（Rust の capabilities と同じ名前・同じ値。platform.rs の capabilities_for） */
export type Capabilities = {
  /** 共有の設定と下書き（client_storage）を Rust で持つ（Windows・Linux の Tauri と、Android） */
  sharedStorage: boolean;
  /** チャットの Rust 経路があるか（Windows・Linux・Android の Tauri。それ以外の OS は無し）。切り替えの設定は無い。Rust の注入値が優先 */
  rustApi: boolean;
  /** 本体の渡し方（Android の WebView は base64） */
  bodyMode: 'raw' | 'base64';
  /** 通知の出し方（Android は常駐サービス、デスクトップはネイティブ通知） */
  notifyBackend: 'android' | 'desktop';
  /** アップデートの経路 */
  updater: 'desktop' | 'android';
  /** 通話の音声出力の切り替えを Kotlin で行う（Android） */
  nativeAudioOutput: boolean;
  /** 画面を切っても動く常駐（Android の前景サービス） */
  backgroundService: boolean;
  /** 画面共有の経路（null は OS の画面共有を使わない） */
  nativeScreen: 'android' | 'linux' | null;
  /** 開発用フォルダを使える */
  devFolder: boolean;
};

/** shared-file storage を使えるか（Windows か Linux の Tauri 版）。Rust の値を優先し、無ければ UA */
export const isSharedStorageOs = isDesktopWindowsOrLinuxTauri;

/**
 * Rust が入れた方針の値（形が正しいものだけ）。無い・形が違うなら fallback を返す。
 * null を許す項目（nativeScreen）は、null も正しい値として扱う。
 */
function fromRust<T>(raw: Record<string, unknown> | null, key: keyof Capabilities, valid: (v: unknown) => boolean, fallback: T): T {
  if (raw && key in raw && valid(raw[key])) return raw[key] as T;
  return fallback;
}

const isBool = (v: unknown): boolean => typeof v === 'boolean';
const oneOf = (...values: unknown[]) => (v: unknown): boolean => values.includes(v);

/**
 * 従来の推測（Rust の値が無いとき）。P0 の特徴付けテストの表と同じ結果になる。
 * ここでは capabilities() を使わない（循環を避ける）。
 */
function inferred(): Capabilities {
  const tauri = isTauri();
  const android = tauri && isAndroid();
  const shared = isSharedStorageOs();
  return {
    // Android は設定と下書きも Rust に寄せた（step6 の (3)）
    sharedStorage: shared || android,
    rustApi: shared || android,
    bodyMode: android ? 'base64' : 'raw',
    notifyBackend: isAndroid() ? 'android' : 'desktop',
    updater: isAndroid() ? 'android' : 'desktop',
    nativeAudioOutput: android,
    backgroundService: android,
    nativeScreen: android ? 'android' : isLinuxDesktop() ? 'linux' : null,
    devFolder: tauri && !isAndroid(),
  };
}

/**
 * このデバイスでの方針。項目ごとに、Rust の値（正しい形のとき）を使い、無ければ推測に戻す。
 * 呼ぶたびに読む（軽い）。デバイスの値は起動の間に変わらない前提。
 */
export function capabilities(): Capabilities {
  const raw = injectedPlatform()?.capabilities ?? null;
  const guess = inferred();
  return {
    sharedStorage: fromRust(raw, 'sharedStorage', isBool, guess.sharedStorage),
    rustApi: fromRust(raw, 'rustApi', isBool, guess.rustApi),
    bodyMode: fromRust(raw, 'bodyMode', oneOf('raw', 'base64'), guess.bodyMode) as Capabilities['bodyMode'],
    notifyBackend: fromRust(raw, 'notifyBackend', oneOf('android', 'desktop'), guess.notifyBackend) as Capabilities['notifyBackend'],
    updater: fromRust(raw, 'updater', oneOf('desktop', 'android'), guess.updater) as Capabilities['updater'],
    nativeAudioOutput: fromRust(raw, 'nativeAudioOutput', isBool, guess.nativeAudioOutput),
    backgroundService: fromRust(raw, 'backgroundService', isBool, guess.backgroundService),
    nativeScreen: fromRust(raw, 'nativeScreen', oneOf('android', 'linux', null), guess.nativeScreen) as Capabilities['nativeScreen'],
    devFolder: fromRust(raw, 'devFolder', isBool, guess.devFolder),
  };
}
