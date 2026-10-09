import { getItem, setItem } from './storage';

const SERVER_KEY = 'disnans.server';
const DEV_USER_KEY = 'disnans.devUser';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 末尾のスラッシュを落とし、スキームがなければ http:// を補う */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

/**
 * サーバーの URL。空文字は同一オリジン（ブラウザでの開発時、Vite のプロキシ経由）。
 */
export function getServerUrl(): string {
  return getItem(SERVER_KEY) ?? '';
}

export function setServerUrl(url: string | null): void {
  setItem(SERVER_KEY, url ? normalizeServerUrl(url) : null);
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

/** <img> などヘッダーを付けられない場所で使う URL */
export function fileUrl(id: string, thumb = false): string {
  return withDevQuery(apiUrl(`/api/files/${encodeURIComponent(id)}${thumb ? '/thumb' : ''}`));
}
