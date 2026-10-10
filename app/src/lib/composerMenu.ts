import Paperclip from '@lucide/svelte/icons/paperclip';
import type { IconRef } from './icons.svelte';
import { composerActions } from './composerActions';
import { commandList, runCommand } from './commands.svelte';

/**
 * 入力欄の「＋」メニューの項目を、利用者の設定（prefs の composerMenu）で並べ替え・絞り込みする。
 * 設定がなければ、本体の「ファイルを添付」→ 登録された操作（プラグインなど）の順。コマンドは設定で足したものだけ出る
 */

/** メニューに並べられる項目の種類 */
export type ComposerMenuKind = 'builtin' | 'action' | 'command';

/** 項目の見た目と識別（id は builtin:・action:・cmd: の接頭辞付き） */
export type ComposerMenuEntry = {
  id: string;
  kind: ComposerMenuKind;
  label: string;
  icon?: IconRef;
  /** 出どころ（プラグイン名など）。本体は省略 */
  source?: string;
};

/** 実行できる項目（＋メニューに出すとき） */
export type ComposerMenuItem = ComposerMenuEntry & {
  /** メインチャットでだけ出す、など（設定画面では見ない） */
  when?: (ctx: { threadId: string | null }) => boolean;
  run: (ctx: { threadId: string | null }) => void | Promise<void>;
};

export type ComposerMenuPrefs = {
  /** 並び順。ここにない項目は既定の順で後ろに続く。コマンドは、ここに入っているものだけ出る */
  order: string[];
  /** 出さない項目の id（並び順には残す） */
  hidden: string[];
};

export const BUILTIN_FILE_ID = 'builtin:file';
export const DEFAULT_COMPOSER_MENU: Readonly<ComposerMenuPrefs> = Object.freeze({ order: [], hidden: [] });

/** 保存したもの（サーバーの設定の composerMenu）を読む。文字列でないものと重複は捨てる。知らない id は残す（入れ直したプラグインのため） */
export function normalizeComposerMenu(raw: unknown): ComposerMenuPrefs {
  const strings = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { order: [], hidden: [] };
  const o = raw as Record<string, unknown>;
  return { order: strings(o.order), hidden: strings(o.hidden) };
}

/**
 * 「＋」メニューの項目。本体の「ファイルを添付」→ 登録された操作 → アプリのコマンド（登録順）。
 * pickFiles は本体の「ファイルを添付」が使う
 */
export function composerMenuAvailable(pickFiles: () => void): ComposerMenuItem[] {
  return [
    { id: BUILTIN_FILE_ID, kind: 'builtin', label: 'ファイルを添付', icon: Paperclip, run: () => pickFiles() },
    ...composerActions().map(
      (a): ComposerMenuItem => ({
        id: `action:${a.id}`,
        kind: 'action',
        label: a.label,
        icon: a.icon,
        source: a.source,
        when: a.when,
        run: (ctx) => a.run(ctx),
      }),
    ),
    ...commandList().map(
      (c): ComposerMenuItem => ({
        id: `cmd:${c.id}`,
        kind: 'command',
        label: c.name,
        icon: c.icon,
        source: c.source,
        run: ({ threadId }) => runCommand(c, { args: '', threadId, via: 'palette' }),
      }),
    ),
  ];
}

/**
 * 表示する項目を、表示の順に返す。available にない id（削除したプラグインなど）は無視する。
 * includeHidden のときは、出さない項目も hidden: true 付きで返す（設定画面用）
 */
export function composerMenuItems<T extends ComposerMenuEntry>(
  available: T[],
  prefs: ComposerMenuPrefs,
  { includeHidden = false }: { includeHidden?: boolean } = {},
): { entry: T; hidden: boolean }[] {
  const byId = new Map<string, T>();
  for (const a of available) if (!byId.has(a.id)) byId.set(a.id, a);
  const hiddenIds = new Set(prefs.hidden);
  const out: { entry: T; hidden: boolean }[] = [];
  const seen = new Set<string>();
  const push = (e: T) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const hidden = hiddenIds.has(e.id);
    if (!hidden || includeHidden) out.push({ entry: e, hidden });
  };
  // 並び順に入っているものが先。コマンドは並び順に入っているものだけ
  for (const id of prefs.order) {
    const e = byId.get(id);
    if (e) push(e);
  }
  // 残りは既定の順（コマンドは足されていなければ出さない）
  for (const e of byId.values()) if (e.kind !== 'command') push(e);
  return out;
}

/** 並び順を、設定画面で見えている順（出さないものも含む）に合わせて書き直す。知らない id は後ろに残す */
function orderWith(available: ComposerMenuEntry[], prefs: ComposerMenuPrefs, shown: string[]): string[] {
  const known = new Set(available.map((a) => a.id));
  return [...shown, ...prefs.order.filter((id) => !known.has(id) && !shown.includes(id))];
}

function visibleIds(available: ComposerMenuEntry[], prefs: ComposerMenuPrefs): string[] {
  return composerMenuItems(available, prefs, { includeHidden: true }).map((x) => x.entry.id);
}

/** 項目を1つ上（dir -1）か下（dir 1）に動かす。端なら何もしない */
export function moveComposerMenuEntry(
  prefs: ComposerMenuPrefs,
  available: ComposerMenuEntry[],
  id: string,
  dir: -1 | 1,
): ComposerMenuPrefs {
  const ids = visibleIds(available, prefs);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return prefs;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ...prefs, order: orderWith(available, prefs, ids) };
}

/** 出す・出さないを切り替える */
export function setComposerMenuHidden(prefs: ComposerMenuPrefs, id: string, hidden: boolean): ComposerMenuPrefs {
  const rest = prefs.hidden.filter((x) => x !== id);
  return { ...prefs, hidden: hidden ? [...rest, id] : rest };
}

/** コマンドを「＋」メニューに足す（末尾・出す状態）。もう入っていれば、出す状態にするだけ */
export function addComposerMenuCommand(prefs: ComposerMenuPrefs, available: ComposerMenuEntry[], id: string): ComposerMenuPrefs {
  const ids = visibleIds(available, prefs);
  if (!ids.includes(id)) ids.push(id);
  return { order: orderWith(available, prefs, ids), hidden: prefs.hidden.filter((x) => x !== id) };
}

/** 項目を「＋」メニューから外す（並び順と非表示の印から消す） */
export function removeComposerMenuEntry(prefs: ComposerMenuPrefs, id: string): ComposerMenuPrefs {
  return { order: prefs.order.filter((x) => x !== id), hidden: prefs.hidden.filter((x) => x !== id) };
}
