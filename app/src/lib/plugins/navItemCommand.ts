// ui.navItem の実体: ナビバーの項目は「コマンド」として登録する（パレットに出て、利用者がナビバーの設定で追加・並べ替えできる）。
// 自動では出さない。badge は未対応（出さない）。setBadge は何もしない。close で外す。
// view を持つ項目は、その view を開いている間はナビで選ばれる（viewCommandOf）。
import { SvelteMap } from 'svelte/reactivity';
import { commandList, registerCommand } from '../commands.svelte';
import { PluginError } from './errors';

export type NavItemSpec = {
  id: string;
  label: string;
  icon: string;
  view?: string;
  onOpen?: () => void;
};

export type NavItemCommandHandle = { setBadge(n: number | string | null): void; close(): void };

/**
 * view の種類 → その view を開く項目のコマンド ID（リアクティブ）。
 * 本体の ui は全プラグインで一つなので、キーは view の種類だけ（openViewByType と同じ。種類はプラグインをまたいで一意に使う）
 */
const viewCommands = new SvelteMap<string, string>();

/** その view を開くコマンド（navItem で view を渡して登録したもの）の ID。なければ null */
export function viewCommandOf(view: string): string | null {
  return viewCommands.get(view) ?? null;
}

export function registerNavItemCommand(spec: NavItemSpec, openView: (view: string) => void): NavItemCommandHandle {
  const cid = `plugin-nav:${spec.id}`;
  if (commandList().some((c) => c.id === cid)) {
    throw new PluginError('invalid_argument', `ナビの項目「${spec.id}」は、もう登録されています`);
  }
  const key = spec.view ?? null;
  if (key !== null) viewCommands.set(key, cid);
  const off = registerCommand({
    id: cid,
    name: spec.label,
    icon: spec.icon,
    run: () => {
      if (spec.view) openView(spec.view);
      spec.onOpen?.();
    },
  });
  return {
    setBadge: () => {},
    close: () => {
      off();
      if (key !== null && viewCommands.get(key) === cid) viewCommands.delete(key);
    },
  };
}
