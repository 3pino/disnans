// 本文のファイルリンクの「開く」を、プラグインに任せるための 1 つの口（disnans.chat.registerLinkOpener）。
// 登録が無ければ本体の既定（保存・拡大表示）のまま。後から登録したものが勝つ。外すと、前のものが戻るわけではなく、空になる。

export type LinkOpener = (path: string, alias: string | null) => void;

let current: LinkOpener | null = null;

export function linkOpener(): LinkOpener | null {
  return current;
}

/** 登録する。戻り値の関数で外す（自分のものだったときだけ空にする） */
export function setLinkOpener(fn: LinkOpener): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}
