import type { PluginInfo } from '../protocol/PluginInfo';
import type { Manifest } from './types';

/** プラグイン ID: 英小文字・数字・ハイフン（2〜32文字） */
export const PLUGIN_ID_RE = /^[a-z0-9-]{2,32}$/;

/** 配布できるファイル */
export const PLUGIN_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;

/**
 * manifest.json を読む（サーバーの決まりに合わせる。description / author は省略すると空、minApiVersion は 1）。
 * 読めなければ、利用者に見せる文言の Error を投げる。
 */
export function parseManifest(text: string): Manifest {
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
  return {
    id,
    name: str('name', true),
    version: str('version', true),
    description: str('description', false),
    author: str('author', false),
    minApiVersion: min,
  };
}

/** サーバーの PluginInfo から manifest を作る */
export function manifestOf(info: PluginInfo): Manifest {
  return {
    id: info.id,
    name: info.name,
    version: info.version,
    description: info.description,
    author: info.author,
    minApiVersion: info.min_api_version,
  };
}
