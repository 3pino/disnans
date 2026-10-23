/**
 * 設定の保存先の決まり（docs/DESIGN.md の「設定の保存先」・crates/client-core/src/view/settings.rs と合わせる）。
 *
 * - ユーザー共通（`/api/me/prefs`）: テーマ・選んだテーマ・ナビゲーションバーの項目と表示名・通話の機器によらない設定
 * - デバイスごと（`/api/me/devices/{id}/prefs`）: 通話の入力・出力の機器・デバイスの種類・ナビバーを隠す・画面の向き・プラグインの無効化・開発フォルダ
 * - ローカル（このデバイスだけ）: 接続先・開発用ユーザー・更新の確認・開発用のフラグ・下書き（ここには入れない）
 *
 * このファイルは純粋な部品だけ（読み書きは stores/prefs・stores/deviceSettings）。
 * 以前の localStorage の値は、サーバーに無いときだけ一度取り込む（legacy*Values）。
 */

import { DEFAULT_NAV_ITEMS } from './navBar';
import { DEFAULT_CALL_SETTINGS } from './call/pure';
import { DEFAULT_ENTER_KEYS } from './enterKeys';
import { DEFAULT_COMPOSER_MENU } from './composerMenu';

export type Raw = Record<string, unknown>;

/**
 * 設定の読み書きの結果（Rust の api_prefs / api_set_prefs と、ブラウザーの HTTP で同じ形）。
 * raw: サーバーの元のオブジェクト（保存するときの下地。知らない項目も残す）。
 * view: 表示に使う値（Rust が正規化したもの。ブラウザーでは足りない項目を既定で埋めただけ）。
 */
export type PrefsResult = { raw: Raw; view: Raw };

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** ユーザー共通の項目（サーバーの prefs のキー） */
export const USER_KEYS = ['theme', 'customTheme', 'navBarItems', 'navBarLabels', 'joinMuted', 'micVolume', 'outVolume', 'limiter', 'limitDb'] as const;
/** 通話の設定のうち、ユーザー共通のもの */
export const CALL_USER_KEYS = ['joinMuted', 'micVolume', 'outVolume', 'limiter', 'limitDb'] as const;
/** 通話の設定のうち、デバイスごとのもの */
export const CALL_DEVICE_KEYS = ['inputId', 'output'] as const;

/** デバイスごとの項目（サーバーのデバイスの prefs のキー） */
export const DEVICE_KEYS = ['inputId', 'output', 'deviceKind', 'hideNavigationBar', 'orientation', 'pluginsDisabled', 'pluginsDevDir'] as const;

/** ユーザー共通の既定値（crates/client-core/src/view/settings.rs の DEFINITIONS と同じ。ブラウザーの表示の補完だけに使う） */
export function userDefaults(): Raw {
  return {
    theme: 'system',
    customTheme: null,
    navBarItems: [...DEFAULT_NAV_ITEMS],
    navBarLabels: {},
    joinMuted: DEFAULT_CALL_SETTINGS.joinMuted,
    micVolume: DEFAULT_CALL_SETTINGS.micVolume,
    outVolume: DEFAULT_CALL_SETTINGS.outVolume,
    limiter: DEFAULT_CALL_SETTINGS.limiter,
    limitDb: DEFAULT_CALL_SETTINGS.limitDb,
    hotkeys: {},
    slashNames: {},
    enterKeys: { ...DEFAULT_ENTER_KEYS },
    composerMenu: { ...DEFAULT_COMPOSER_MENU },
  };
}

/** 表示の値の補完（足りない項目だけ既定で埋める。値の型は直さない。直すのは Rust の正規化） */
export function fillUserDefaults(raw: Raw): Raw {
  return { ...userDefaults(), ...raw };
}

/** Rust を通さない（ブラウザーの開発）ときの設定の結果。raw はそのまま、view は既定で埋めたもの */
export function prefsResultOf(raw: unknown): PrefsResult {
  const o = isObject(raw) ? raw : {};
  return { raw: o, view: fillUserDefaults(o) };
}

/** デバイスの既定値（crates/client-core/src/view/settings.rs の DEFINITIONS と同じ） */
export const DEVICE_DEFAULTS: Readonly<Raw> = Object.freeze({
  inputId: '',
  output: null,
  deviceKind: null,
  hideNavigationBar: false,
  orientation: 'auto',
  pluginsDisabled: [],
  pluginsDevDir: null,
});

/** 以前の localStorage の保存先（読むだけ）。値は文字列（JSON のものは JSON 文字列） */
export const LEGACY = {
  theme: 'disnans.theme',
  customTheme: 'disnans.customTheme',
  navBarItems: 'disnans.navBarItems',
  navBarLabels: 'disnans.navBarLabels',
  call: 'disnans.call.settings',
  callVoice: 'disnans.plugin.voice.data',
  hideNavigationBar: 'disnans.hideNavigationBar',
  orientation: 'disnans.orientation',
  deviceKind: 'disnans.deviceKind',
  pluginsDisabled: 'disnans.plugins.disabled',
  pluginsDevDir: 'disnans.plugins.devDir',
} as const;

export type LegacyRead = (key: string) => string | null;

/** 保存された JSON を読む。読めなければ undefined（無いのと同じ扱い） */
function readJson(read: LegacyRead, key: string): unknown {
  const raw = read(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 通話の旧い保存先（新しいものが無ければ引き継ぐ）の中身。オブジェクトでなければ null */
function legacyCall(read: LegacyRead): Raw | null {
  const v = read(LEGACY.call) !== null ? readJson(read, LEGACY.call) : readJson(read, LEGACY.callVoice);
  return isObject(v) ? v : null;
}

/**
 * 以前の localStorage から、ユーザー共通の値を読む（あったものだけ。無いものは含めない）。
 * 値は型を見ずにそのまま入れる。保存のあとの表示は Rust が正規化する（段 E。TS では直さない）
 */
export function legacyUserValues(read: LegacyRead): Raw {
  const out: Raw = {};
  const theme = read(LEGACY.theme);
  if (theme !== null) out.theme = theme;
  const custom = read(LEGACY.customTheme);
  if (custom !== null && custom !== '') out.customTheme = custom;
  const items = readJson(read, LEGACY.navBarItems);
  if (Array.isArray(items)) out.navBarItems = items;
  const labels = readJson(read, LEGACY.navBarLabels);
  if (isObject(labels)) out.navBarLabels = labels;
  const call = legacyCall(read);
  if (call) for (const k of CALL_USER_KEYS) if (k in call) out[k] = call[k];
  return out;
}

/** 以前の localStorage から、デバイスごとの値を読む（あったものだけ） */
export function legacyDeviceValues(read: LegacyRead): Raw {
  const out: Raw = {};
  const hide = read(LEGACY.hideNavigationBar);
  if (hide !== null) out.hideNavigationBar = hide === '1';
  const orientation = read(LEGACY.orientation);
  if (orientation !== null) out.orientation = orientation;
  const kind = read(LEGACY.deviceKind);
  if (kind !== null) out.deviceKind = kind;
  const disabled = readJson(read, LEGACY.pluginsDisabled);
  if (Array.isArray(disabled)) out.pluginsDisabled = disabled.filter((x): x is string => typeof x === 'string');
  const dir = read(LEGACY.pluginsDevDir);
  if (dir !== null && dir.trim() !== '') out.pluginsDevDir = dir.trim();
  const call = legacyCall(read);
  if (call) {
    for (const k of CALL_DEVICE_KEYS) if (k in call) out[k] = call[k];
  }
  return out;
}

/** デバイスの設定の表示の補完（足りない項目だけ既定で埋める。型は直さない。直すのは Rust の正規化） */
export function fillDeviceDefaults(raw: Raw): Raw {
  return { ...DEVICE_DEFAULTS, ...raw };
}

/** 設定の変更の失敗などを、利用者に知らせるための口（App が起動時に差し替える。既定は console） */
let settingsErrorHandler: (text: string) => void = (text) => console.error(text);

export function setSettingsErrorHandler(fn: (text: string) => void): void {
  settingsErrorHandler = fn;
}

export function reportSettingsError(text: string): void {
  settingsErrorHandler(text);
}
