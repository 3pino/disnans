/**
 * Tauri で既定のブラウザー（別のアプリ）で開くリンクの URL。開かないなら null。
 * 押した場所の処理が既定の動作を止めた（preventDefault）ものは開かない
 * （共有フォルダの一覧で、名前を押して書き換える・選択モードで選び直すときなど）。
 * 同じオリジン・http(s) でないリンクも開かない
 */
export function externalLinkHref(e: Pick<MouseEvent, 'target' | 'defaultPrevented'>, origin: string): string | null {
  if (e.defaultPrevented) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || !/^https?:/i.test(a.href) || a.origin === origin) return null;
  return a.href;
}
