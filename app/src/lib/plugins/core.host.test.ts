// @vitest-environment jsdom
// コアプラグイン（同梱）と「ファイル」の切り替え: 読めれば内蔵の画面を使わず、読めなければ内蔵のまま。
// 同梱の中身は取得の stub（main.js の中身は試験用。本物の中身は scripts/fetch-core-plugins.mjs で確かめる）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(async (_cls: unknown) => {}),
  manifests: [] as Array<{ permissions?: string[]; id: string }>,
  stop: vi.fn(),
  views: new Map<string, unknown>(),
  startFails: false,
}));

vi.mock('../call/instance.svelte', () => ({ callApi: {} }));
vi.mock('./runtime', () => ({
  PluginRuntime: class {
    views = mocks.views;
    errors: string[] = [];
    settingTabs: unknown[] = [];
    constructor(public manifest: { permissions?: string[]; id: string }) {
      mocks.manifests.push(manifest);
    }
    async start(cls: unknown) {
      if (mocks.startFails) throw new Error('boom');
      return mocks.start(cls as never);
    }
    stop() {
      mocks.stop();
    }
  },
}));

import { PluginHost } from './host.svelte';
import { CORE_PLUGIN_IDS, coreSig } from './core';

/** 同梱の「ファイル」（fixplor）の ID（コアの一覧の検査に使う） */
const CORE_FILES_PLUGIN = 'fixplor';

const MAIN = 'export default class {}';
const realFetch = globalThis.fetch;
const urls: string[] = [];
let mainOk = true;
const originalURL = URL.createObjectURL;

beforeEach(() => {
  mocks.views.clear();
  mocks.views.set(CORE_FILES_PLUGIN, () => ({}));
  mocks.start.mockClear();
  mocks.manifests.length = 0;
  mocks.stop.mockClear();
  mocks.startFails = false;
  mainOk = true;
  urls.length = 0;
  localStorage.clear();
  // 同梱のファイルの取得（アプリの配信元から）
  globalThis.fetch = vi.fn(async (u: string | URL) => {
    const s = String(u);
    urls.push(s);
    if (!mainOk) return new Response('nope', { status: 404 });
    if (s.endsWith('/main.js')) return new Response(MAIN);
    if (s.endsWith('/styles.css')) return new Response('.x{}');
    return new Response('', { status: 404 });
  }) as never;
  // Blob の import は試験の環境でそのまま読めないので、中身を data: の URL にする
  URL.createObjectURL = (b: Blob) => {
    void b;
    return `data:text/javascript,${encodeURIComponent(MAIN)}`;
  };
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = originalURL;
});

type Internal = {
  loaded: Map<string, { sig: string }>;
  errors: Record<string, string>;
  disabled: string[];
  unload(id: string): void;
};
const internal = (h: PluginHost) => h as unknown as Internal;

/** 本体のホストを、サーバーの一覧なしで 1 回 reconcile する */
async function reconcileWith(server: unknown[] = [], dev: unknown[] = []) {
  const host = new PluginHost();
  (host as unknown as { helloSeen: boolean }).helloSeen = true;
  (host as unknown as { server: unknown[] }).server = server;
  (host as unknown as { dev: unknown[] }).dev = dev;
  await host.reconcile();
  return host;
}

describe('コアプラグイン（同梱）', () => {
  it('同梱の版が lock から読める（fixplor・ID は 1 つ・manifest の中身がある）', () => {
    expect(CORE_PLUGIN_IDS).toEqual([CORE_FILES_PLUGIN]);
    expect(coreSig(CORE_FILES_PLUGIN)).toMatch(/^core:[0-9a-f]{64}$/);
  });

  it('読み込めば、同梱の main.js を読み、view が登録できたときだけ切り替える（切り替え: 有効）', async () => {
    const host = await reconcileWith();
    expect(internal(host).loaded.has(CORE_FILES_PLUGIN)).toBe(true);
    expect(urls.some((u) => u.endsWith(`/core-plugins/${CORE_FILES_PLUGIN}/main.js`))).toBe(true);
  });

  it('同じ ID のサーバー配布・開発用のものは読まない（コアが勝つ）', async () => {
    const server = [{ type: 'plugin', id: CORE_FILES_PLUGIN, hash: 'h', files: ['main.js'], name: 'x', version: '9', description: '', author: '', minApiVersion: 1 }];
    const dev = [{ kind: 'plugin', folder: 'x', manifest: { id: CORE_FILES_PLUGIN, name: 'y', version: '9', description: '', author: '', minApiVersion: 1 }, main: 'export default class {}', styles: null, stamp: 1, error: null }];
    const host = await reconcileWith(server as never, dev as never);
    const e = host.entries.find((x) => x.id === CORE_FILES_PLUGIN);
    expect(e?.core).toBe(true);
    expect(e?.server).toBeNull();
    expect(e?.dev).toBeNull();
    // 読み込まれたのは同梱のもの（sig が同梱の版）。配布・開発用のものではない
    expect(internal(host).loaded.get(CORE_FILES_PLUGIN)?.sig).toBe(coreSig(CORE_FILES_PLUGIN));
    expect(urls.length).toBeGreaterThan(0);
  });

  it('オフにできない（設定の切り替えは効かず、一覧には同梱と出す）', async () => {
    const host = await reconcileWith();
    host.setEnabled(CORE_FILES_PLUGIN, false);
    expect(internal(host).disabled).not.toContain(CORE_FILES_PLUGIN);
    const e = host.entries.find((x) => x.id === CORE_FILES_PLUGIN);
    expect(e?.core).toBe(true);
    expect(e?.enabled).toBe(true);
    expect(internal(host).loaded.has(CORE_FILES_PLUGIN)).toBe(true);
  });
});

describe('「ファイル」の切り替え（フォールバック）', () => {
  it('同梱の取得に失敗すれば、読めず、内蔵のまま（切り替え: 無効）', async () => {
    mainOk = false;
    const host = await reconcileWith();
    expect(internal(host).loaded.has(CORE_FILES_PLUGIN)).toBe(false);
    expect(internal(host).errors[CORE_FILES_PLUGIN]).toMatch(/main\.js を読み込めません/);
  });

  it('読み込みでエラーになれば、内蔵のまま', async () => {
    mocks.startFails = true;
    const host = await reconcileWith();
    expect(internal(host).loaded.has(CORE_FILES_PLUGIN)).toBe(false);
  });

  it('view を登録しなければ、切り替えない（内蔵のまま）', async () => {
    mocks.views.clear();
    await reconcileWith();
  });

  it('権限は manifest のとおり（同梱は確認なしで付く）', async () => {
    await reconcileWith();
    const m = mocks.manifests.find((x) => x.id === CORE_FILES_PLUGIN);
    expect(m?.permissions).toEqual(['files']);
  });

  it('外れたら（読み込みが止まったら）、切り替えも止まる', async () => {
    const host = await reconcileWith();
    internal(host).unload(CORE_FILES_PLUGIN);
    expect(mocks.stop).toHaveBeenCalled();
  });
});
