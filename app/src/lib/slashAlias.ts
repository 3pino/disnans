import { SLASH_NAME_RE } from './slashCommands.svelte';

// スラッシュコマンドの別名（利用者が決める `/名前`）。コマンド ID → 別名。
// 別名を付けると、そのコマンドは元の名前では呼べず、別名で呼ぶ（補完・入力もすべて別名）。元の名前に戻すと別名を消す。
// 保存は prefs の slashNames（サーバーに置き、同じユーザーの端末で共有する）

export type SlashAliases = Record<string, string>;

/** 保存したもの（prefs の slashNames）を読む。文字列でない・不正な名前は捨てる */
export function normalizeSlashAliases(raw: unknown): SlashAliases {
  const out: SlashAliases = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) if (typeof v === 'string' && SLASH_NAME_RE.test(v)) out[id] = v;
  return out;
}

/** 別名を付ける（null で消す）。ほかのコマンドの別名は変えない */
export function setSlashAlias(aliases: SlashAliases, commandId: string, alias: string | null): SlashAliases {
  const next = { ...aliases };
  if (alias === null) delete next[commandId];
  else next[commandId] = alias;
  return next;
}

export type SlashAliasCheck = { ok: true; alias: string | null } | { ok: false; error: string };

/**
 * 入力された別名を確かめる。
 * - original: コマンドが元から持つ名前（`slash`）。入力がこれと同じなら別名は付けない（alias: null）
 * - taken: ほかのスラッシュコマンドが使っている名前（いまの名前。このコマンド自身のものは入れない）
 * 空・英小文字数字ハイフン以外・32 字超え・重複は弾く。前後の空白は除く
 */
export function checkSlashAlias(input: string, { original, taken }: { original?: string; taken: string[] }): SlashAliasCheck {
  const name = input.trim();
  if (name === '') return { ok: false, error: '名前を入力してください' };
  if (!SLASH_NAME_RE.test(name)) {
    return { ok: false, error: '英小文字・数字・ハイフンだけを使えます（先頭は英小文字か数字、32 文字まで）' };
  }
  if (taken.includes(name)) return { ok: false, error: `「/${name}」はほかのコマンドで使われています` };
  return { ok: true, alias: name === original ? null : name };
}
