// ui.navItem の実体: ナビバーの項目は「コマンド」として登録する（パレットに出て、利用者がナビバーの設定で追加・並べ替えできる）。
// 自動では出さない。badge は未対応（出さない）。setBadge は何もしない。close で外す。
import { commandList, registerCommand } from '../commands.svelte';
import { PluginError } from './errors';
import { CORE_REPLACED_NAV_IDS } from './core';

export type NavItemSpec = {
  id: string;
  label: string;
  icon: string;
  view?: string;
  onOpen?: () => void;
};

export type NavItemCommandHandle = { setBadge(n: number | string | null): void; close(): void };

export function registerNavItemCommand(spec: NavItemSpec, openView: (view: string) => void): NavItemCommandHandle {
  // コアの「ファイル」は、本体の「共有フォルダを開く」が入口（二重に出さない）
  if (CORE_REPLACED_NAV_IDS.includes(spec.id)) return { setBadge: () => {}, close: () => {} };
  const cid = `plugin-nav:${spec.id}`;
  if (commandList().some((c) => c.id === cid)) {
    throw new PluginError('invalid_argument', `ナビの項目「${spec.id}」は、もう登録されています`);
  }
  const off = registerCommand({
    id: cid,
    name: spec.label,
    icon: spec.icon,
    run: () => {
      if (spec.view) openView(spec.view);
      spec.onOpen?.();
    },
  });
  return { setBadge: () => {}, close: () => off() };
}
