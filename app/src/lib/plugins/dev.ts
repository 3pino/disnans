// 開発用フォルダ（PC 版だけ）。プラグインとテーマを置く。中身は src-tauri/src/dev_plugins.rs

import { isAndroid, isTauri } from '../config';

/** dev_plugins_scan の1件 */
export type DevPluginStat = { folder: string; files: string[]; stamp: string };

/** dev_plugin_read の結果 */
export type DevPluginFiles = {
  folder: string;
  manifest: string | null;
  main: string | null;
  styles: string | null;
  /** theme.css（テーマのとき） */
  theme: string | null;
  /** icon.svg（任意） */
  icon: string | null;
  stamp: string;
};

/** 開発用フォルダを使えるか（Tauri のデスクトップ版だけ） */
export function devFolderSupported(): boolean {
  return isTauri() && !isAndroid();
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function scanDevFolder(dir: string): Promise<DevPluginStat[]> {
  return invoke<DevPluginStat[]>('dev_plugins_scan', { dir });
}

export function readDevPlugin(dir: string, folder: string): Promise<DevPluginFiles> {
  return invoke<DevPluginFiles>('dev_plugin_read', { dir, folder });
}
