import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootReadApi, bootWriteApi, currentBootEnv } from './boot';

// 起動時の経路（api.ts は bootReadApi() / bootWriteApi() の結果を読み込み時に1回だけ使う）。
// 読取・書込・添付は、どの OS でも Rust（Tauri）だけ。HTTP の経路は無い。

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const OTHER = 'Mozilla/5.0 (OtherOS; x86_64)';

type Env = { ua: string; server?: string };

function stubEnvironment(env: Env) {
  const store = new Map<string, string>();
  if (env.server) store.set('disnans.server', env.server);
  // 古い開発用フラグ（disnans.rustApi = "0"）が残っていても、Rust 経路のまま
  store.set('disnans.rustApi', '0');
  const win: Record<string, unknown> = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem() {}, removeItem() {} },
    location: { search: '' },
    __TAURI_INTERNALS__: {},
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: env.ua, platform: '' });
}

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ id: 'u1' });
  vi.stubGlobal('fetch', async () => {
    throw new Error('HTTP is not used');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function readApi(env: Env) {
  stubEnvironment(env);
  return bootReadApi({ ...currentBootEnv(), invoke: invoke as never });
}

function writeApi(env: Env) {
  stubEnvironment(env);
  return bootWriteApi({ ...currentBootEnv(), invoke: invoke as never });
}

describe('boot-time transport choice (Rust only)', () => {
  it.each([
    ['Linux', LINUX],
    ['Windows', WINDOWS],
    ['another OS', OTHER],
  ])('reads go through invoke on %s, even with the old flag set to "0"', async (_name, ua) => {
    const api = readApi({ ua, server: 'http://127.0.0.1:8080' });
    expect(await api.me()).toEqual({ id: 'u1' });
    expect(invoke).toHaveBeenCalledWith('api_me', { args: { server: 'http://127.0.0.1:8080', devUser: null } });
  });

  it('writes and uploads go through invoke too', async () => {
    const api = writeApi({ ua: LINUX, server: 'http://127.0.0.1:8080' });
    await api.write.clearAvatar();
    expect(invoke).toHaveBeenCalledWith('api_clear_avatar', expect.anything());
  });
});
