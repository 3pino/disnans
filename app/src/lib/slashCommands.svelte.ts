import type { IconRef } from './icons.svelte';

/** コマンドの引数の候補 */
export type SlashArgSuggestion = { value: string; label?: string; description?: string };

/**
 * 入力欄の `/コマンド`。本体のものもプラグインのもの（addSlashCommand）もここに登録する。
 * `/コマンド 引数` で始まるメッセージは、送らずに run を呼ぶ
 */
export type SlashCommandDef = {
  /** 英小文字・数字・ハイフン */
  name: string;
  description: string;
  /** 引数の書き方（`<本文>` など）。補完のヒントに出す */
  args?: string;
  /** 打っている引数（コマンド名のあと）から候補を返す。選んだ候補の value で引数を置き換える */
  suggestArgs?: (input: string) => SlashArgSuggestion[];
  run(ctx: { args: string; threadId: string | null }): void | Promise<void>;
  /** 補完に出すアイコン（Svelte の部品か、アイコンの名前）。省略するとアイコンなし */
  icon?: IconRef;
  /** 補完に出す出どころ（プラグイン名など）。本体のコマンドは省略 */
  source?: string;
};

export const SLASH_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

let commands = $state.raw<SlashCommandDef[]>([]);

/** 登録されているコマンド（リアクティブ） */
export const slashCommands = {
  get list(): SlashCommandDef[] {
    return commands;
  },
};

/** コマンドを登録する。同名は後勝ち。返り値の関数で解除する（解除しても前のものには戻らない） */
export function registerSlashCommand(cmd: SlashCommandDef): () => void {
  if (!SLASH_NAME_RE.test(cmd.name)) throw new Error(`コマンド名には英小文字・数字・ハイフンだけを使えます: ${cmd.name}`);
  commands = [...commands.filter((c) => c.name !== cmd.name), cmd];
  return () => {
    commands = commands.filter((c) => c !== cmd);
  };
}

export function findSlashCommand(name: string): SlashCommandDef | undefined {
  return commands.find((c) => c.name === name);
}

export type SlashInput = { kind: 'message'; body: string } | { kind: 'command'; name: string; args: string };

/**
 * 送ろうとしている本文を、普通のメッセージとコマンドに分ける。
 * `//` で始まるときは、先頭の `/` を1つ取った普通のメッセージ
 */
export function parseSlashInput(body: string): SlashInput {
  if (body.startsWith('//')) return { kind: 'message', body: body.slice(1) };
  if (!body.startsWith('/')) return { kind: 'message', body };
  const m = /^\/(\S*)([\s\S]*)$/.exec(body)!;
  return { kind: 'command', name: m[1], args: m[2].trim() };
}

/**
 * コマンドを実行する。知らないコマンドや run の失敗は、利用者に見せる文言の Error で reject する
 */
export async function runSlashCommand(name: string, args: string, threadId: string | null): Promise<void> {
  const cmd = findSlashCommand(name);
  if (!cmd) {
    throw new Error(`「/${name}」というコマンドはありません（/ で始まる文を送るときは // で始めます）`);
  }
  try {
    await cmd.run({ args, threadId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`/${name}: ${msg}`);
  }
}
