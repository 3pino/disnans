import { getItem, setItem } from './storage';
import { isTauri } from './platform';
import { sharedPath } from './sharedPath';

const SERVER_KEY = 'disnans.server';
const DEV_USER_KEY = 'disnans.devUser';
let serverUrlOverride: string | undefined;

/** 末尾のスラッシュを落とし、スキームがなければ http:// を補う */
export function normalizeServerUrl(input: string): string {
  // 日本語 IME で入力された全角文字（／：． など）を半角にする
  let s = input.normalize('NFKC').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

/** Canonical form for the Windows/Linux shared-file namespace; browser legacy behavior stays above. */
export function canonicalServerUrl(input: string): string {
  const unfolded = input.normalize('NFKC').trim();
  const explicitScheme = unfolded.split('://', 2);
  if (explicitScheme.length === 2 && !/^https?$/i.test(explicitScheme[0])) {
    throw new Error('サーバー URL は http/https のみ利用できます');
  }
  const normalized = normalizeServerUrl(input);
  if (!normalized) return '';
  const parsed = new URL(normalized);
  const authority = normalized.split('://', 2)[1]?.split(/[/?#]/, 1)[0] ?? '';
  if (
    !/^https?:$/.test(parsed.protocol) || !parsed.hostname || authority.includes('@') ||
    parsed.username || parsed.password || normalized.includes('?') || normalized.includes('#')
  ) {
    throw new Error('サーバー URL が不正です');
  }
  return parsed.href.replace(/\/+$/, '');
}

/**
 * サーバーの URL。空文字は同一オリジン（ブラウザでの開発時、Vite のプロキシ経由）。
 */
export function getServerUrl(): string {
  return serverUrlOverride !== undefined ? serverUrlOverride : getItem(SERVER_KEY) ?? '';
}

const serverChangeListeners = new Set<() => void>();

/** 接続先のサーバーが変わったとき（旧サーバーの手元の写しを捨てるため）に呼ばれる。解除関数を返す */
export function onServerChange(fn: () => void): () => void {
  serverChangeListeners.add(fn);
  return () => serverChangeListeners.delete(fn);
}

/** 実効の URL が変わっていれば、変わったと知らせる */
function notifyIfChanged(before: string): void {
  if (getServerUrl() === before) return;
  for (const fn of [...serverChangeListeners]) fn();
}

/** Set the already-resolved shared-file value in memory without rewriting legacy storage. */
export function applyServerUrl(url: string | null): void {
  const before = getServerUrl();
  applyServerUrlRaw(url);
  notifyIfChanged(before);
}

function applyServerUrlRaw(url: string | null): void {
  if (!url) {
    serverUrlOverride = '';
    return;
  }
  try {
    serverUrlOverride = canonicalServerUrl(url);
  } catch {
    // Keep the prior GUI behavior for invalid legacy values; a shared IPC write will reject them.
    serverUrlOverride = normalizeServerUrl(url);
  }
}

/** Browser/Android-compatible synchronous setter. Desktop hosts persist through shared storage first. */
export function setServerUrl(url: string | null): void {
  const before = getServerUrl();
  const normalized = url ? normalizeServerUrl(url) : '';
  setItem(SERVER_KEY, normalized || null);
  // Legacy clients keep reading localStorage, including external changes and failed writes.
  serverUrlOverride = undefined;
  notifyIfChanged(before);
}

/** Tauri ではサーバーの指定が必須 */
export function needsServerSetup(): boolean {
  return isTauri() && !getServerUrl();
}

/**
 * 開発用: `?dev_user=alice` で別ユーザーとして振る舞う。タブごとに sessionStorage に覚える。
 */
function initDevUser(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const p = new URLSearchParams(window.location.search).get('dev_user');
    if (p !== null) {
      setItem(DEV_USER_KEY, p || null, 'session');
      return p || null;
    }
  } catch {
    // 無視
  }
  return getItem(DEV_USER_KEY, 'session');
}

export const devUser: string | null = initDevUser();

function withDevQuery(url: string): string {
  if (!devUser) return url;
  return url + (url.includes('?') ? '&' : '?') + 'dev_user=' + encodeURIComponent(devUser);
}

export function apiUrl(path: string): string {
  return getServerUrl() + path;
}

export function authHeaders(): Record<string, string> {
  return devUser ? { 'X-Dev-User': devUser } : {};
}

export function wsUrl(): string {
  const base = getServerUrl();
  let url: string;
  if (base) {
    url = base.replace(/^http/i, 'ws') + '/api/ws';
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${proto}//${window.location.host}/api/ws`;
  }
  return withDevQuery(url);
}

/**
 * `User.avatar_url` を <img> で使える URL にする。自分で設定したアバターはサーバーからの相対パス
 * （`/api/avatars/{id}`）なので、サーバーの URL を前に付ける。Tailscale の画像はそのまま
 */
export function avatarSrc(url: string): string {
  return url.startsWith('/') ? withDevQuery(apiUrl(url)) : url;
}

/** 自分で設定したアバターか（Tailscale のプロフィール画像ではない） */
export function isCustomAvatar(url: string | null | undefined): boolean {
  return !!url && url.startsWith('/api/avatars/');
}

/** 共有フォルダのファイルの URL（<a> や <img> で使う。`/api/shared/<パス>`。dev_user は付く） */
export function sharedFileUrl(path: string): string {
  return withDevQuery(apiUrl(sharedPath(path)));
}

/** <img> などヘッダーを付けられない場所で使う URL */
export function fileUrl(id: string, thumb = false): string {
  return withDevQuery(apiUrl(`/api/files/${encodeURIComponent(id)}${thumb ? '/thumb' : ''}`));
}
