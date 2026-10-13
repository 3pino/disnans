import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootReadApi, currentBootEnv } from './boot';
import { createHttpReadApi } from './http';

// 起動時の経路の決め方（api.ts は bootReadApi() の結果を読み込み時に1回だけ使う）。
// 決定関数を、スタブした実行環境から直接検証する。

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)';

type Env = { flag?: string; ua: string; tauri: boolean; server?: string };

function stubBrowser(env: Env) {
  const store = new Map<string, string>();
  if (env.server) store.set('disnans.server', env.server);
  if (env.flag !== undefined) store.set('disnans.rustApi', env.flag);
  const win: Record<string, unknown> = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem() {}, removeItem() {} },
    location: { search: '' },
  };
  if (env.tauri) win.__TAURI_INTERNALS__ = {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: env.ua, platform: '' });
}

let invoke: ReturnType<typeof vi.fn>;
let fetchCalls: string[];

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ id: 'u1' });
  fetchCalls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(url);
    return new Response(JSON.stringify({ id: 'u-http' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 起動時の環境から経路を決める（Tauri 側の invoke だけ差し替える） */
function boot(env: Env) {
  stubBrowser(env);
  return bootReadApi({ ...currentBootEnv(), invoke: invoke as never });
}

describe('boot-time read transport choice', () => {
  it('unset on Linux Tauri: Rust is the default', () => {
    expect(boot({ ua: LINUX, tauri: true, server: 'http://127.0.0.1:8080' }).kind).toBe('tauri');
  });

  it('flag "0": HTTP, invoke is never called', () => {
    const choice = boot({ flag: '0', ua: LINUX, tauri: true, server: 'http://127.0.0.1:8080' });
    expect(choice.kind).toBe('http');
    expect(console.info).toHaveBeenCalledWith('[disnans] api read transport: http');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('flag on on Linux Tauri: Rust, reads use the fixed command with the current server', async () => {
    const choice = boot({ flag: '1', ua: LINUX, tauri: true, server: 'http://127.0.0.1:8080' });
    expect(choice.kind).toBe('tauri');
    expect(await choice.api.me()).toEqual({ id: 'u1' });
    expect(invoke).toHaveBeenCalledWith('api_me', { args: { server: 'http://127.0.0.1:8080', devUser: null } });
    expect(console.info).toHaveBeenCalledWith('[disnans] api read transport: tauri');
  });

  it('no flag on Windows Tauri: Rust is the default', () => {
    expect(boot({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', tauri: true, server: 'http://127.0.0.1:8080' }).kind).toBe('tauri');
  });

  it('macOS: HTTP even without a flag', () => {
    expect(boot({ ua: MAC, tauri: true, server: 'http://127.0.0.1:8080' }).kind).toBe('http');
  });

  it('flag on but macOS: HTTP', () => {
    expect(boot({ flag: '1', ua: MAC, tauri: true, server: 'http://127.0.0.1:8080' }).kind).toBe('http');
  });

  it('no flag in a browser (no Tauri): HTTP', () => {
    expect(boot({ ua: LINUX, tauri: false, server: 'http://127.0.0.1:8080' }).kind).toBe('http');
  });

  it('flag on in a browser (no Tauri): HTTP', () => {
    expect(boot({ flag: '1', ua: LINUX, tauri: false, server: 'http://127.0.0.1:8080' }).kind).toBe('http');
  });

  it('the HTTP implementation still fetches the same URL', async () => {
    stubBrowser({ ua: LINUX, tauri: true, server: 'http://127.0.0.1:8080' });
    await createHttpReadApi().me();
    expect(fetchCalls).toEqual(['http://127.0.0.1:8080/api/me']);
  });
});
