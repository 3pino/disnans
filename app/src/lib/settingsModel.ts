/**
 * 設定の保存先の決まり（docs/PLAN_SERVER_SETTINGS.md・crates/client-core/src/view/settings.rs と合わせる）。
 *
 * - ユーザー共通（`/api/me/prefs`）: テーマ・選んだテーマ・ナビゲーションバーの項目と表示名・通話の機器によらない設定
 * - 端末ごと（`/api/me/devices/{id}/prefs`）: 通話の入力・出力の機器・端末の種類・ナビバーを隠す・画面の向き・プラグインの無効化・開発フォルダ
 * - ローカル（この端末だけ）: 接続先・開発用ユーザー・更新の確認・開発用のフラグ・下書き（ここには入れない）
 *
 * このファイルは純粋な部品だけ（読み書きは stores/prefs・stores/deviceSettings）。
 * 以前の localStorage の値は、サーバーに無いときだけ一度取り込む（legacy*Values）。
 */

import { normalizeNavItems, normalizeNavLabels } from './navBar';
import { parseCallSettings, type CallSettingsData } from './call/pure';
import { normalizeOrientationMode, type OrientationMode } from './orientation';

export type Raw = Record<string, unknown>;

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** ユーザー共通の項目（サーバーの prefs のキー） */
export const USER_KEYS = ['theme', 'customTheme', 'navBarItems', 'navBarLabels', 'joinMuted', 'micVolume', 'outVolume', 'limiter', 'limitDb'] as const;
/** 通話の設定のうち、ユーザー共通のもの */
export const CALL_USER_KEYS = ['joinMuted', 'micVolume', 'outVolume', 'limiter', 'limitDb'] as const;
/** 通話の設定のうち、端末ごとのもの */
export const CALL_DEVICE_KEYS = ['inputId', 'output'] as const;

/** 端末ごとの項目（サーバーの端末の prefs のキー） */
export const DEVICE_KEYS = ['inputId', 'output', 'deviceKind', 'hideNavigationBar', 'orientation', 'pluginsDisabled', 'pluginsDevDir'] as const;

/** 端末の既定値（crates/client-core/src/view/settings.rs の DEFINITIONS と同じ） */
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

/** 端末の種類（deviceKind.svelte.ts と同じ一覧） */
const DEVICE_KIND_LIST = ['smartphone', 'tablet', 'laptop', 'monitor'];

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
 * 通話の値は parseCallSettings で範囲に収めてから入れる
 */
export function legacyUserValues(read: LegacyRead): Raw {
  const out: Raw = {};
  const theme = read(LEGACY.theme);
  if (theme !== null && (THEME_CHOICES as readonly string[]).includes(theme)) out.theme = theme;
  const custom = read(LEGACY.customTheme);
  if (custom !== null && custom !== '') out.customTheme = custom;
  const items = readJson(read, LEGACY.navBarItems);
  if (Array.isArray(items)) out.navBarItems = normalizeNavItems(items);
  const labels = readJson(read, LEGACY.navBarLabels);
  if (isObject(labels)) out.navBarLabels = normalizeNavLabels(labels);
  const call = legacyCall(read);
  if (call) {
    const parsed = parseCallSettings(call);
    for (const k of CALL_USER_KEYS) if (k in call) out[k] = parsed[k];
  }
  return out;
}

/** 以前の localStorage から、端末ごとの値を読む（あったものだけ） */
export function legacyDeviceValues(read: LegacyRead): Raw {
  const out: Raw = {};
  const hide = read(LEGACY.hideNavigationBar);
  if (hide !== null) out.hideNavigationBar = hide === '1';
  const orientation = read(LEGACY.orientation);
  if (orientation !== null) out.orientation = normalizeOrientationMode(orientation);
  const kind = read(LEGACY.deviceKind);
  if (kind !== null && DEVICE_KIND_LIST.includes(kind)) out.deviceKind = kind;
  const disabled = readJson(read, LEGACY.pluginsDisabled);
  if (Array.isArray(disabled)) out.pluginsDisabled = disabled.filter((x): x is string => typeof x === 'string');
  const dir = read(LEGACY.pluginsDevDir);
  if (dir !== null && dir.trim() !== '') out.pluginsDevDir = dir.trim();
  const call = legacyCall(read);
  if (call) {
    const parsed = parseCallSettings(call);
    for (const k of CALL_DEVICE_KEYS) if (k in call) out[k] = parsed[k];
  }
  return out;
}

/** 端末の設定を型に合わせる（キャッシュから読んだものに使う。サーバーの正規化と同じ形にそろえる） */
export function normalizeDevicePrefs(raw: unknown): Raw {
  const o = isObject(raw) ? raw : {};
  const kind = o.deviceKind;
  const output = o.output;
  return {
    ...o,
    inputId: typeof o.inputId === 'string' ? o.inputId : '',
    output: isObject(output) && typeof output.id === 'string' ? output : null,
    deviceKind: typeof kind === 'string' && DEVICE_KIND_LIST.includes(kind) ? kind : null,
    hideNavigationBar: o.hideNavigationBar === true,
    orientation: normalizeOrientationMode(o.orientation) as OrientationMode,
    pluginsDisabled: Array.isArray(o.pluginsDisabled) ? o.pluginsDisabled.filter((x): x is string => typeof x === 'string') : [],
    pluginsDevDir: typeof o.pluginsDevDir === 'string' && o.pluginsDevDir !== '' ? o.pluginsDevDir : null,
  };
}

/** テーマの値（知らない値は system） */
export function normalizeTheme(raw: unknown): ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(raw) ? (raw as ThemeChoice) : 'system';
}

/** 通話のユーザー共通の値（範囲に収める） */
export function callUserSettings(raw: Raw): CallSettingsData {
  return parseCallSettings(raw);
}

/** 設定の変更の失敗などを、利用者に知らせるための口（App が起動時に差し替える。既定は console） */
let settingsErrorHandler: (text: string) => void = (text) => console.error(text);

export function setSettingsErrorHandler(fn: (text: string) => void): void {
  settingsErrorHandler = fn;
}

export function reportSettingsError(text: string): void {
  settingsErrorHandler(text);
}
