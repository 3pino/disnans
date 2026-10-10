import type { IconRef } from './icons.svelte';
import { hotkeyId, matchHotkey, parseHotkey, worksWhileTyping, type Hotkey } from './plugins/hotkey';
import { registerSlashCommand, SLASH_NAME_RE, type SlashArgSuggestion } from './slashCommands.svelte';
import type { SlashAliases } from './slashAlias';

/** コマンドをどこから実行したか */
export type CommandVia = 'hotkey' | 'palette' | 'slash';

export type CommandContext = {
  /** `/コマンド` のあとの文字列（前後の空白は除く）。ホットキー・パレットからは空文字列 */
  args: string;
  /** スラッシュコマンドは入力したスレッド、ほかは開いているスレッド（なければ null） */
  threadId: string | null;
  via: CommandVia;
};

/**
 * アプリの操作1つ。本体のもの（app:）とプラグインのもの（<プラグイン ID>:）をここに登録する。
 * ホットキー（設定で変えられる）・コマンドパレット・スラッシュコマンド（slash があれば）から実行できる
 */
export type AppCommand = {
  /** `app:open-settings`、`dice:quick-roll` など。ホットキーの設定の保存に使う */
  id: string;
  /** 表示名（パレット・設定に出す） */
  name: string;
  /** アイコン（Svelte の部品か、アイコンの名前） */
  icon?: IconRef;
  /** 既定のホットキー（"Mod+Shift+D" 形式。複数なら配列）。利用者が設定で変えられる */
  defaultHotkey?: string | string[];
  /** スラッシュコマンドとしての名前（`/` のあと。英小文字・数字・ハイフン）。利用者は設定で別名を付けられる。省略するとスラッシュコマンドにしない */
  slash?: string;
  /** スラッシュコマンドの補完に出す説明（省略すると name） */
  description?: string;
  /** スラッシュコマンドの引数の書き方（補完のヒント） */
  args?: string;
  /** スラッシュコマンドの引数の候補 */
  suggestArgs?: (input: string) => SlashArgSuggestion[];
  /** 出どころ（プラグイン名など）。本体のコマンドは省略 */
  source?: string;
  run(ctx: CommandContext): void | Promise<void>;
};

/** 本体のコマンドの ID の接頭辞 */
export const APP_COMMAND_PREFIX = 'app:';

let commands = $state.raw<AppCommand[]>([]);

/** 登録されているコマンド（リアクティブ）。登録した順 */
export function commandList(): AppCommand[] {
  return commands;
}

export function findCommand(id: string): AppCommand | undefined {
  return commands.find((c) => c.id === id);
}

/** 利用者が付けたスラッシュコマンドの別名（prefs の slashNames）を返す源。lib/commandHost.svelte.ts が設定する */
let slashAliasSource: () => SlashAliases = () => ({});

export function setSlashAliasSource(fn: () => SlashAliases): void {
  slashAliasSource = fn;
}

/**
 * いまのスラッシュコマンドの名前。別名があればそれ、なければ slash。slash のないコマンドは undefined
 */
export function effectiveSlash(cmd: AppCommand, aliases: SlashAliases = slashAliasSource()): string | undefined {
  if (!cmd.slash) return undefined;
  return Object.hasOwn(aliases, cmd.id) ? aliases[cmd.id] : cmd.slash;
}

/**
 * コマンドを登録する。同じ ID は後勝ち。slash があればスラッシュコマンドにも登録する。
 * 返り値の関数で解除する（解除しても前のものには戻らない）
 */
export function registerCommand(cmd: AppCommand): () => void {
  if (!cmd.id) throw new Error('コマンドの id が空です');
  if (cmd.slash && !SLASH_NAME_RE.test(cmd.slash)) {
    throw new Error(`コマンド名には英小文字・数字・ハイフンだけを使えます: ${cmd.slash}`);
  }
  let offSlash: (() => void) | null = null;
  if (cmd.slash) {
    offSlash = registerSlashCommand({
      // 名前は別名があればそれ。別名はそのつど引く（設定で変えたらすぐ補完・解決に効く）
      get name() {
        return effectiveSlash(cmd) ?? cmd.slash!;
      },
      description: cmd.description || cmd.name,
      args: cmd.args,
      suggestArgs: cmd.suggestArgs,
      run: ({ args, threadId }) => cmd.run({ args, threadId, via: 'slash' }),
      // アイコンはあとから変わることがある（プラグインの icon.svg など）ので、そのつど引く
      get icon() {
        return cmd.icon;
      },
      source: cmd.source,
    });
  }
  commands = [...commands.filter((c) => c.id !== cmd.id), cmd];
  return () => {
    offSlash?.();
    commands = commands.filter((c) => c !== cmd);
  };
}

/** コマンドを実行する。失敗は、利用者に見せる文言（「名前: 理由」）の Error で reject する */
export async function runCommand(cmd: AppCommand, ctx: CommandContext): Promise<void> {
  try {
    await cmd.run(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${cmd.name}: ${msg}`);
  }
}

// ---- ホットキー ----

/**
 * 利用者の設定（コマンド ID → ホットキーの一覧。空の一覧は「なし」）。項目がなければ既定のもの。
 * 古い保存値（1つの文字列。"" は「なし」）も読む
 */
export type HotkeyOverrides = Record<string, string[]>;

/** 保存したもの（サーバーの設定の hotkeys）を読む。文字列（1つだけの古い形）は一覧にする。それ以外は捨てる */
export function normalizeHotkeys(raw: unknown): HotkeyOverrides {
  const out: HotkeyOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[id] = v === '' ? [] : [v];
    else if (Array.isArray(v)) out[id] = [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))];
  }
  return out;
}

/** 既定のホットキー（なければ空の一覧） */
export function defaultHotkeys(cmd: AppCommand): string[] {
  return ([] as string[]).concat(cmd.defaultHotkey ?? []).filter((t) => t !== '');
}

/** いま効いているホットキー（"Mod+Shift+D" 形式の一覧）。設定がなければ既定 */
export function effectiveHotkeys(cmd: AppCommand, overrides: HotkeyOverrides): string[] {
  return Object.hasOwn(overrides, cmd.id) ? overrides[cmd.id] : defaultHotkeys(cmd);
}

/** 既定と同じ並び（同じキーの組み合わせ）か */
function sameHotkeys(a: string[], b: string[]): boolean {
  const ida = a.map((t) => hotkeyId(t));
  const idb = b.map((t) => hotkeyId(t));
  return ida.length === idb.length && ida.every((x, i) => x === idb[i]);
}

/** 既定から変えているか */
export function isHotkeyCustomized(cmd: AppCommand, overrides: HotkeyOverrides): boolean {
  return Object.hasOwn(overrides, cmd.id) && !sameHotkeys(overrides[cmd.id], defaultHotkeys(cmd));
}

/**
 * 利用者の設定として保存する値。既定と同じなら null（設定を消す。既定が変わったときに追従する）
 */
export function hotkeyOverride(cmd: AppCommand, list: string[]): string[] | null {
  return sameHotkeys(list, defaultHotkeys(cmd)) ? null : list;
}

/** ホットキーを足す（同じキーがもうあれば変えない） */
export function addHotkey(list: string[], text: string): string[] {
  const id = hotkeyId(text);
  if (list.some((t) => hotkeyId(t) === id)) return list;
  return [...list, text];
}

/** ホットキーを外す（同じキーのものを外す） */
export function removeHotkey(list: string[], text: string): string[] {
  const id = hotkeyId(text);
  return list.filter((t) => hotkeyId(t) !== id);
}

/**
 * 同じホットキーになっているコマンド。コマンド ID → ぶつかっているほかのコマンド（登録順）。
 * どれか1つでも同じキーがあればぶつかる。ぶつかっていないコマンドは入らない
 */
export function findHotkeyConflicts(list: AppCommand[], overrides: HotkeyOverrides, mac?: boolean): Map<string, AppCommand[]> {
  const byKey = new Map<string, AppCommand[]>();
  const keysOf = new Map<AppCommand, string[]>();
  for (const c of list) {
    const keys = [...new Set(effectiveHotkeys(c, overrides).map((t) => hotkeyId(t, mac)).filter((k): k is string => !!k))];
    keysOf.set(c, keys);
    for (const k of keys) {
      const same = byKey.get(k);
      if (same) same.push(c);
      else byKey.set(k, [c]);
    }
  }
  const out = new Map<string, AppCommand[]>();
  for (const c of list) {
    const others = new Set<AppCommand>();
    for (const k of keysOf.get(c) ?? []) for (const x of byKey.get(k) ?? []) if (x !== c) others.add(x);
    // 登録順に並べる
    if (others.size > 0) out.set(c.id, list.filter((x) => others.has(x)));
  }
  return out;
}

/**
 * キーの入力に合うコマンド（なければ null）。typing は入力欄で打っている最中か
 * （そのときは Ctrl・Cmd・Alt を含むものと F1〜F12 だけ）。ぶつかっていたら先に登録したもの
 */
export function commandForKey(
  list: AppCommand[],
  overrides: HotkeyOverrides,
  e: KeyboardEvent,
  { typing = false, mac }: { typing?: boolean; mac?: boolean } = {},
): AppCommand | null {
  for (const c of list) {
    for (const text of effectiveHotkeys(c, overrides)) {
      const hk: Hotkey | null = parseHotkey(text, mac);
      if (!hk || (typing && !worksWhileTyping(hk))) continue;
      if (matchHotkey(hk, e)) return c;
    }
  }
  return null;
}

// ---- パレット ----

/** ひらがな・カタカナ・全角英数を見分けずに比べるための形 */
function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** query の文字が、この順に s に出てくるか（あいまい検索） */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

/**
 * パレットの絞り込み。名前・スラッシュコマンド名・出どころを見る。
 * 前方一致 → 部分一致 → あいまい一致（文字が順に出てくる）の順。空なら本体のもの → プラグインのもの、それぞれ名前順
 */
export function filterCommands(list: AppCommand[], query: string): AppCommand[] {
  const q = fold(query.trim()).replace(/^\//, '');
  const byName = (a: AppCommand, b: AppCommand) =>
    Number(!!a.source) - Number(!!b.source) || a.name.localeCompare(b.name, 'ja');
  if (!q) return [...list].sort(byName);
  const words = q.split(/\s+/);
  const score = (c: AppCommand): number => {
    const name = fold(c.name);
    const slash = effectiveSlash(c);
    const all = [name, slash ? fold(slash) : '', c.source ? fold(c.source) : ''].join(' ');
    if (name.startsWith(q) || (slash && fold(slash).startsWith(q))) return 0;
    if (words.every((w) => all.includes(w))) return 1;
    if (isSubsequence(q.replace(/\s+/g, ''), name)) return 2;
    return -1;
  };
  return list
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || byName(a.c, b.c))
    .map((x) => x.c);
}
