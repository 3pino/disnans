// コアプラグイン: アプリに同梱するプラグイン（app/core-plugins.lock.json の版を、scripts/fetch-core-plugins.mjs が public/core-plugins/<id>/ に置く）。
// 利用者はオン・オフできない（設定の一覧には出す）。同じ ID のサーバー配布・開発用のものは読まない（コアが勝つ）。
// 権限は manifest の permissions のとおり（確認はしない。アプリと同じ署名の範囲）。
// sig は main.js の sha256（= この版の中身。アプリの版が変われば変わる）。
import lock from '../../../core-plugins.lock.json';
import type { Manifest } from './types';

type LockEntry = { repo: string; tag: string; minApiVersion: number; manifest: Manifest; files: Record<string, string> };
const LOCK = lock as Record<string, LockEntry>;

/** コアプラグインの ID（lock の順） */
export const CORE_PLUGIN_IDS: readonly string[] = Object.keys(LOCK);

export function isCorePlugin(id: string): boolean {
  return Object.hasOwn(LOCK, id);
}

/** 同梱の manifest（設定の一覧・版の確かめに使う。lock と同じ中身） */
export function coreManifest(id: string): Manifest | null {
  return LOCK[id]?.manifest ?? null;
}

/** 同梱の中身の識別子（読み直しの sig に使う） */
export function coreSig(id: string): string {
  return `core:${LOCK[id]?.files['main.js'] ?? ''}`;
}

/** 同梱のファイルの URL（アプリの配信元。Vite の base に従う） */
export function coreFileUrl(id: string, name: string): string {
  const base = new URL(import.meta.env.BASE_URL, location.href);
  return new URL(`core-plugins/${id}/${name}`, base).href;
}

export async function fetchCoreText(id: string, name: string): Promise<string> {
  const res = await fetch(coreFileUrl(id, name), { cache: 'no-store' });
  if (!res.ok) throw new Error(`同梱の ${name} を読めません（HTTP ${res.status}）`);
  return res.text();
}

/** 本体の「ファイル」の代わりに使うコアプラグイン（読み込めたら、本体の内蔵の画面は出さない） */
export const CORE_FILES_PLUGIN = 'fixplor';
export const CORE_FILES_VIEW = 'fixplor';
/**
 * コアが ui.navItem で登録しても、ナビの項目（コマンド）にしない ID。「ファイル」の入口は本体のコマンド「共有フォルダを開く」（app:open-files）だけ。
 */
export const CORE_REPLACED_NAV_IDS: readonly string[] = [`${CORE_FILES_PLUGIN}:files`];
