import Paperclip from '@lucide/svelte/icons/paperclip';
import Camera from '@lucide/svelte/icons/camera';
import type { IconRef } from './icons.svelte';
import { composerActions } from './composerActions';
import { commandList, runCommand } from './commands.svelte';
import { moveItem } from './sortable';

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
  /** 出すかどうか（設定画面では見ない） */
  when?: () => boolean;
  run: () => void | Promise<void>;
};

export type ComposerMenuPrefs = {
  /** 並び順。ここにない項目は既定の順で後ろに続く。コマンドは、ここに入っているものだけ出る */
  order: string[];
  /** 出さない項目の id（並び順には残す） */
  hidden: string[];
};

export const BUILTIN_FILE_ID = 'builtin:file';
export const BUILTIN_CAMERA_ID = 'builtin:camera';
export const DEFAULT_COMPOSER_MENU: Readonly<ComposerMenuPrefs> = Object.freeze({ order: [], hidden: [] });

/** 以前は「＋」メニューの既定の項目だった「通話に参加」（登録した操作の id）。いまは出さず、コマンド「通話に参加する」に置き換えた */
export const LEGACY_CALL_JOIN_ACTION_ID = 'action:app:call-join';
/** 「通話に参加する」コマンドの「＋」メニューの id */
export const CALL_JOIN_COMMAND_ID = 'cmd:app:call-join';
/** composerMenu の移行の版。これより古い（版のない）保存値は、読むときに移行する */
export const COMPOSER_MENU_VERSION = 2;

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
 * 保存した composerMenu を新しい版に移す（一度だけ）。版のない保存値は、既定で「通話に参加」が出ていた扱いにする。
 * 出していた（隠していない）なら「通話に参加する」コマンドを、「ファイルを添付」の直後（並び順にあれば同じ位置）に入れる。
 * 隠していたなら、何も入れない。どちらでも、旧い「通話に参加」の項目の印は消す。
 * changed は、版を書き込む必要があるとき true（保存し直す）。移行後の値は版の印を持つので、二度は変えない
 */
export function migrateComposerMenu(raw: unknown): { value: Record<string, unknown>; changed: boolean } {
  const base: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (base.v === COMPOSER_MENU_VERSION) return { value: base, changed: false };
  const prefs = normalizeComposerMenu(base);
  const callJoinOn = !prefs.hidden.includes(LEGACY_CALL_JOIN_ACTION_ID);
  let order = prefs.order.filter((id) => id !== LEGACY_CALL_JOIN_ACTION_ID);
  if (callJoinOn && !order.includes(CALL_JOIN_COMMAND_ID)) {
    // 並び順が空なら、既定の並び（ファイルを添付が先頭）を書き出してから入れる
    const list = prefs.order.length > 0 ? prefs.order.filter((id) => id !== LEGACY_CALL_JOIN_ACTION_ID) : [BUILTIN_FILE_ID];
    const legacyAt = prefs.order.indexOf(LEGACY_CALL_JOIN_ACTION_ID);
    if (legacyAt >= 0) {
      // 並び順に「通話に参加」があれば、その位置に置き換える
      order = [...order.slice(0, legacyAt), CALL_JOIN_COMMAND_ID, ...order.slice(legacyAt)];
    } else {
      const at = list.indexOf(BUILTIN_FILE_ID);
      order = [...list.slice(0, at + 1), CALL_JOIN_COMMAND_ID, ...list.slice(at + 1)];
    }
  }
  const value = { ...base, order, hidden: prefs.hidden.filter((id) => id !== LEGACY_CALL_JOIN_ACTION_ID), v: COMPOSER_MENU_VERSION };
  return { value, changed: true };
}

/**
 * 「＋」メニューの項目。本体の「ファイルを添付」→ 登録された操作 → アプリのコマンド（登録順）。
 * pickFiles は本体の「ファイルを添付」が使う
 */
export function composerMenuAvailable(pickFiles: () => void, takePhoto: () => void = () => {}): ComposerMenuItem[] {
  return [
    { id: BUILTIN_FILE_ID, kind: 'builtin', label: 'ファイルを添付', icon: Paperclip, run: () => pickFiles() },
    { id: BUILTIN_CAMERA_ID, kind: 'builtin', label: '写真を撮る', icon: Camera, run: () => takePhoto() },
    ...composerActions().map(
      (a): ComposerMenuItem => ({
        id: `action:${a.id}`,
        kind: 'action',
        label: a.label,
        icon: a.icon,
        source: a.source,
        when: a.when,
        run: () => a.run(),
      }),
    ),
    ...commandList().map(
      (c): ComposerMenuItem => ({
        id: `cmd:${c.id}`,
        kind: 'command',
        label: c.name,
        icon: c.icon,
        source: c.source,
        run: () => runCommand(c, { args: '', via: 'palette' }),
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

/**
 * 項目を、表示の並びの toIndex 番目に動かす（並べ替えのリストで使う）。
 * toIndex は範囲に収めて扱う。動かさないときは同じ prefs を返す
 */
export function reorderComposerMenuEntry(
  prefs: ComposerMenuPrefs,
  available: ComposerMenuEntry[],
  id: string,
  toIndex: number,
): ComposerMenuPrefs {
  const ids = visibleIds(available, prefs);
  const from = ids.indexOf(id);
  if (from < 0) return prefs;
  const to = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (to === from) return prefs;
  return { ...prefs, order: orderWith(available, prefs, moveItem(ids, from, to)) };
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
