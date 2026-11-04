// @vitest-environment jsdom
// 本体の機能に入った旧いプラグイン（retired）が、ホストで読み込まれない・一覧に出ない・オンにできないことを、
// api（配布・ファイル取得）と script の作成（Blob URL）の境目で確かめる。ほかのプラグインは影響を受けない。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevPlugin } from './host.svelte';
import type { PluginInfo } from '../protocol/PluginInfo';

const fake = vi.hoisted(() => ({
  servers: [] as unknown[],
  files: {} as Record<string, string>,
  fetched: [] as string[],
}));

vi.mock('../api', async (importOriginal) => {
  const m = await importOriginal<typeof import('../api')>();
  return {
    ...m,
    api: {
      ...m.api,
      plugins: async () => fake.servers,
      pluginFile: async (id: string, file: string) => {
        fake.fetched.push(`${id}/${file}`);
        return fake.files[`${id}/${file}`] ?? '';
      },
    },
  };
});

// 通話の本体は、別の作業（engine）が途中のため読まない（ホストが使うのは callApi の口だけ。ここでは使わない）
vi.mock('../call/instance.svelte', () => ({ callApi: {} }));

import { PluginHost } from './host.svelte';
import { deviceSettings } from '../stores/deviceSettings.svelte';

/** Blob の中身（main.js の本文と、末尾の sourceURL の印）を読む */
function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

function serverPlugin(id: string): PluginInfo {
  return {
    id,
    type: 'plugin',
    name: id,
    version: '1.0.0',
    description: '',
    author: '',
    min_api_version: 1,
    api_version: 1,
    icon: null,
    has_icon: false,
    hash: `h-${id}`,
    files: ['main.js', 'manifest.json'],
  } as unknown as PluginInfo;
}

function devPlugin(id: string): DevPlugin {
  return {
    kind: 'plugin',
    folder: `${id}-dev`,
    manifest: { id, name: id, version: '0.0.1', description: '', author: '', minApiVersion: 1, apiVersion: 1 },
    main: `export default class {} /* dev ${id} */`,
    styles: null,
    icon: null,
    stamp: 1,
    error: null,
  } as unknown as DevPlugin;
}

/** script として作られた本文（sourceURL の印で、どのプラグインかを見分ける） */
let scripts: string[] = [];
/** Blob の本文を読む途中のもの（読み終えるまで待つ。待たないと、否定の確かめが空振りする） */
let reading: Promise<unknown>[] = [];

beforeEach(() => {
  fake.servers = [serverPlugin('screenshare'), serverPlugin('dice')];
  fake.files = {
    'screenshare/main.js': 'export default class {} /* server screenshare */',
    'screenshare/manifest.json': '{"id":"screenshare","name":"screenshare","version":"1.0.0","minApiVersion":1,"permissions":[]}',
    'dice/main.js': 'export default class {} /* server dice */',
    'dice/manifest.json': '{"id":"dice","name":"dice","version":"1.0.0","minApiVersion":1,"permissions":[]}',
  };
  fake.fetched = [];
  scripts = [];
  reading = [];
  let n = 0;
  URL.createObjectURL = vi.fn((b: Blob) => {
    reading.push(readBlob(b).then((text) => scripts.push(text)));
    return `blob:fake/${++n}`;
  });
  URL.revokeObjectURL = vi.fn();
});

/** 読み込みが終わるまで待つ（ホストは順番に走らせる） */
async function settle(host: PluginHost) {
  await host.refreshServer();
  await host.reconcile();
  await Promise.all(reading);
}

describe('旧いプラグインのホストでの扱い（配布と開発用フォルダ）', () => {
  it('配布の一覧にあっても、取得も script の作成もしない（ほかのプラグインは読む）', async () => {
    const host = new PluginHost();
    (host as unknown as { onHello(): void }).onHello();
    await settle(host);

    // 取得の境目: 旧いプラグインのファイルは一つも取りに行かない
    expect(fake.fetched.filter((f) => f.startsWith('screenshare/'))).toEqual([]);
    // 対照: ほかのプラグインは取りに行く（この経路が動いていることの確かめ）
    expect(fake.fetched).toContain('dice/main.js');
    // script の境目: 旧いプラグインの本文は作られない
    expect(scripts.some((t) => t.includes('server screenshare'))).toBe(false);
    expect(scripts.some((t) => t.includes('server dice'))).toBe(true);
    // 一覧: 行が出ない、読み込みのエラーも出ない
    const ids = host.entries.map((e) => e.id);
    expect(ids).not.toContain('screenshare');
    expect(ids).toContain('dice');
    expect(host.errors).not.toHaveProperty('screenshare');
    expect(host.runtime('screenshare')).toBeNull();
  });

  it('開発用フォルダにあっても、script を作らず、一覧にも出ない', async () => {
    const host = new PluginHost();
    (host as unknown as { onHello(): void }).onHello();
    host.dev = [devPlugin('screenshare'), devPlugin('mytool')];
    await settle(host);

    expect(scripts.some((t) => t.includes('dev screenshare'))).toBe(false);
    expect(scripts.some((t) => t.includes('dev mytool'))).toBe(true);
    const ids = host.entries.map((e) => e.id);
    expect(ids).not.toContain('screenshare');
    expect(ids).toContain('mytool');
    expect(host.runtime('screenshare')).toBeNull();
  });

  it('オンにするのは効かない（設定を変えず、読み込みも起こさない）。オフは、ほかのプラグインと同じく効く', async () => {
    const host = new PluginHost();
    (host as unknown as { onHello(): void }).onHello();
    await settle(host);
    const setSpy = vi.spyOn(deviceSettings, 'set').mockImplementation(() => {});

    host.setEnabled('screenshare', true);
    host.setEnabled('screenshare', false);
    expect(setSpy).not.toHaveBeenCalled();
    expect(host.isEnabled('screenshare')).toBe(true);

    // 対照: ほかのプラグインのオフは、設定へ書かれる（他の動きは変わらない）
    host.setEnabled('dice', false);
    expect(setSpy).toHaveBeenCalledWith('pluginsDisabled', ['dice']);
    setSpy.mockRestore();
  });

  it('読み込みの途中で（取得のあとに）旧いものだと分かっても、script を作らず登録しない', async () => {
    const host = new PluginHost();
    const wanted = {
      sig: 'server:h-screenshare',
      manifest: { id: 'screenshare', name: 'screenshare', version: '1.0.0', description: '', author: '', minApiVersion: 1 },
      load: async () => ({ main: 'export default class {} /* inflight screenshare */', styles: null, permissions: [] }),
    };
    await (host as unknown as { load(id: string, w: unknown): Promise<void> }).load('screenshare', wanted);
    await Promise.all(reading);
    expect(scripts.some((t) => t.includes('inflight screenshare'))).toBe(false);
    expect(host.runtime('screenshare')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
