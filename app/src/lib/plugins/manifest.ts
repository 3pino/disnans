import type { PluginInfo } from '../protocol/PluginInfo';
import type { PluginKind } from '../protocol/PluginKind';
import type { Manifest } from './types';

/** プラグイン ID: 英小文字・数字・ハイフン（2〜32文字） */
export const PLUGIN_ID_RE = /^[a-z0-9-]{2,32}$/;

/** 配布できるファイル（プラグインは manifest.json / main.js / styles.css / icon.svg、テーマは manifest.json / theme.css / icon.svg） */
export const PLUGIN_FILES = ['manifest.json', 'main.js', 'styles.css', 'theme.css', 'icon.svg'] as const;

/** manifest の icon（Lucide のアイコン名）: 英小文字・数字・ハイフン */
export const MANIFEST_ICON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * manifest.json を読む（サーバーの決まりに合わせる。description / author は省略すると空、minApiVersion は 1、icon は省略できる）。
 * 読めなければ、利用者に見せる文言の Error を投げる。
 */
export function parseManifest(text: string): Manifest {
  return parsePackageManifest(text).manifest;
}

/** manifest.json を読み、種類（`type`。省略すると plugin）も返す */
export function parsePackageManifest(text: string): { manifest: Manifest; kind: PluginKind } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`manifest.json を読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('manifest.json はオブジェクトにしてください');
  const o = v as Record<string, unknown>;
  const str = (k: string, required: boolean): string => {
    const x = o[k];
    if (typeof x === 'string' && (x !== '' || !required)) return x;
    if (x === undefined && !required) return '';
    throw new Error(`manifest.json の ${k} がありません（文字列）`);
  };
  const id = str('id', true);
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`manifest.json の id「${id}」は、英小文字・数字・ハイフンの 2〜32 文字にしてください`);
  const min = o.minApiVersion ?? 1;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) throw new Error('manifest.json の minApiVersion は整数にしてください');
  // 作られた対象の版（任意。1 以上の整数で、minApiVersion 以上）。省略すると minApiVersion とみなす
  const api = o.apiVersion;
  if (api !== undefined && (typeof api !== 'number' || !Number.isInteger(api) || api < 1 || api < min)) {
    throw new Error('manifest.json の apiVersion は 1 以上の整数で、minApiVersion 以上にしてください');
  }
  const icon = o.icon;
  if (icon !== undefined && (typeof icon !== 'string' || !MANIFEST_ICON_RE.test(icon))) {
    throw new Error('manifest.json の icon は Lucide のアイコン名（英小文字・数字・ハイフン。例: "dice-5"）にしてください');
  }
  const type = o.type ?? 'plugin';
  if (type !== 'plugin' && type !== 'theme') throw new Error('manifest.json の type は "plugin" か "theme" にしてください');
  const m: Manifest = {
    id,
    name: str('name', true),
    version: str('version', true),
    description: str('description', false),
    author: str('author', false),
    minApiVersion: min,
  };
  if (icon !== undefined) m.icon = icon;
  if (api !== undefined) m.apiVersion = api;
  return { manifest: m, kind: type };
}

/** サーバーの PluginInfo から manifest を作る */
export function manifestOf(info: PluginInfo): Manifest {
  const api = info.api_version;
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    description: info.description,
    author: info.author,
    minApiVersion: info.min_api_version,
    ...(api !== null ? { apiVersion: api } : {}),
    ...(info.icon ? { icon: info.icon } : {}),
  };
}
