// 端末の判定（ステップ7）。
// Tauri では Rust が `window.__DISNANS_PLATFORM__`（app/src-tauri/src/platform.rs）に端末の事実と方針（capabilities）を入れる。
// 値が正しい形で有れば、それを使う（UA 文字列を見ない）。無い・壊れている項目は、従来どおり UA などから推測する（安全側）。
// ブラウザー（Tauri でない）は Rust が無いので、常に推測する。
// ここに判定を集める。呼び出し側は capabilities() か、個別の関数（isTauri など）を使う。

/** Rust が入れる端末の事実（JSON は camelCase。platform.rs の PlatformInfo と揃える） */
export type InjectedPlatform = {
  /** "windows" | "linux" | "macos" | "android" | "ios" | "other" */
  os: string;
  /** デスクトップの Tauri か（windows・linux・macos） */
  desktop: boolean;
  /** Android の Tauri か */
  android: boolean;
  /** 方針（形が違う項目は capabilities() が推測に戻す）。無いこともある */
  capabilities: Record<string, unknown> | null;
};

/** この端末での方針（Rust の capabilities と同じ名前・同じ値。platform.rs の capabilities_for） */
export type Capabilities = {
  /** 共有の設定と下書き（client_storage）を Rust で持つ（Windows・Linux の Tauri と、Android） */
  sharedStorage: boolean;
  /** 読取・書込・添付を Rust 経路で行う（既定で on。localStorage の "0" で off） */
  rustApi: boolean;
  /** チャットの経路。"default" は Rust（S7 で逃げ道を廃止）、"off" は JS Socket（ブラウザーと macOS） */
  rustChat: 'default' | 'off';
  /** 本体の渡し方（Android の WebView は base64） */
  bodyMode: 'raw' | 'base64';
  /** 通知の出し方（web はブラウザー） */
  notifyBackend: 'android' | 'desktop' | 'web';
  /** アップデートの経路（null は対象外） */
  updater: 'desktop' | 'android' | null;
  /** 通話の音声出力の切り替えを Kotlin で行う（Android） */
  nativeAudioOutput: boolean;
  /** 画面を切っても動く常駐（Android の前景サービス） */
  backgroundService: boolean;
  /** 画面共有の経路（null は OS の画面共有を使わない） */
  nativeScreen: 'android' | 'linux' | null;
  /** 開発用フォルダを使える */
  devFolder: boolean;
};

type WithInjected = { __DISNANS_PLATFORM__?: unknown };

/** Rust が入れた端末の事実。無い・形が違うときは null（呼び出し側は推測する） */
export function injectedPlatform(): InjectedPlatform | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as WithInjected).__DISNANS_PLATFORM__;
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.os !== 'string' || typeof v.desktop !== 'boolean' || typeof v.android !== 'boolean') return null;
  const caps = v.capabilities && typeof v.capabilities === 'object' ? (v.capabilities as Record<string, unknown>) : null;
  return { os: v.os, desktop: v.desktop, android: v.android, capabilities: caps };
}

/** Tauri の中か（WebView の内部オブジェクトの有無） */
/** この端末の OS の名前（windows・linux・macos・android・ios。分からなければ空）。Rust の値が正しければそれ、無ければ UA から */
export function osName(): string {
  const os = injectedPlatform()?.os;
  if (os && os !== 'other') return os;
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/windows/i.test(ua)) return 'windows';
  if (/linux/i.test(ua)) return 'linux';
  return '';
}

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

/** UA と platform の文字列から、shared-file storage を使う端末か（Windows か Linux で、Android でない） */
export function supportsDesktopStoragePlatform(userAgent: string, platform = ''): boolean {
  const agent = `${userAgent} ${platform}`;
  return /windows|linux/i.test(agent) && !/android/i.test(agent);
}

/** shared-file storage を使えるか（Windows か Linux の Tauri 版。macOS とブラウザーは使わない）。Rust の値を優先し、無ければ UA */
export function isSharedStorageOs(): boolean {
  if (!isTauri() || isAndroid()) return false;
  const info = injectedPlatform();
  if (info) return info.os === 'windows' || info.os === 'linux';
  return typeof navigator !== 'undefined' && supportsDesktopStoragePlatform(navigator.userAgent, navigator.platform);
}

/** Mac か（キーの表記。Cmd と Ctrl の扱い）。iPhone・iPad も含める（従来どおり） */
export function isMacLike(): boolean {
  const info = injectedPlatform();
  if (info) return info.os === 'macos' || info.os === 'ios';
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/**
 * Rust が入れた方針の値（形が正しいものだけ）。無い・形が違うなら fallback を返す。
 * null を許す項目（updater・nativeScreen）は、null も正しい値として扱う。
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
    rustChat: shared || android ? 'default' : 'off',
    bodyMode: android ? 'base64' : 'raw',
    notifyBackend: !tauri ? 'web' : isAndroid() ? 'android' : 'desktop',
    updater: !tauri ? null : isAndroid() ? 'android' : 'desktop',
    nativeAudioOutput: android,
    backgroundService: android,
    nativeScreen: android ? 'android' : isLinuxDesktop() ? 'linux' : null,
    devFolder: tauri && !isAndroid(),
  };
}

/**
 * この端末での方針。項目ごとに、Rust の値（正しい形のとき）を使い、無ければ推測に戻す。
 * 呼ぶたびに読む（軽い）。端末の値は起動の間に変わらない前提。
 */
export function capabilities(): Capabilities {
  const raw = injectedPlatform()?.capabilities ?? null;
  const guess = inferred();
  return {
    sharedStorage: fromRust(raw, 'sharedStorage', isBool, guess.sharedStorage),
    rustApi: fromRust(raw, 'rustApi', isBool, guess.rustApi),
    rustChat: fromRust(raw, 'rustChat', oneOf('default', 'off'), guess.rustChat) as Capabilities['rustChat'],
    bodyMode: fromRust(raw, 'bodyMode', oneOf('raw', 'base64'), guess.bodyMode) as Capabilities['bodyMode'],
    notifyBackend: fromRust(raw, 'notifyBackend', oneOf('android', 'desktop'), guess.notifyBackend) as Capabilities['notifyBackend'],
    updater: fromRust(raw, 'updater', oneOf('desktop', 'android', null), guess.updater) as Capabilities['updater'],
    nativeAudioOutput: fromRust(raw, 'nativeAudioOutput', isBool, guess.nativeAudioOutput),
    backgroundService: fromRust(raw, 'backgroundService', isBool, guess.backgroundService),
    nativeScreen: fromRust(raw, 'nativeScreen', oneOf('android', 'linux', null), guess.nativeScreen) as Capabilities['nativeScreen'],
    devFolder: fromRust(raw, 'devFolder', isBool, guess.devFolder),
  };
}
