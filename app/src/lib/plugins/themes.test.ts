// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInfo } from '../protocol/PluginInfo';
import type { DevPlugin } from './host.svelte';
import { parsePackageManifest } from './manifest';

const pluginFile = vi.fn(async (_id: string, _name: string, hash: string) => `:root{--accent:${hash}}`);
vi.mock('../api', () => ({ api: { pluginFile: (id: string, name: string, hash: string) => pluginFile(id, name, hash) } }));

const { themeHost, THEME_STYLE_SELECTOR } = await import('./themes.svelte');

function server(id: string, hash: string, type: PluginInfo['type'] = 'theme'): PluginInfo {
  return {
    id,
    type,
    visibility: 'public',
    owner: null,
    name: id,
    version: '1',
    description: '',
    author: '',
    min_api_version: 1,
    icon: null,
    has_icon: false,
    files: ['manifest.json', 'theme.css'],
    hash,
    updated_by: 'u',
    updated_at: 0,
  };
}

function dev(id: string, stamp: string, css: string): DevPlugin {
  return {
    folder: id,
    stamp,
    manifest: { id, name: id, version: '1', description: '', author: '', minApiVersion: 1 },
    kind: 'theme',
    manifestText: '{}',
    main: null,
    styles: null,
    theme: css,
    icon: null,
    error: null,
  };
}

const styleText = () => document.head.querySelector(THEME_STYLE_SELECTOR)?.textContent ?? null;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('parsePackageManifest', () => {
  it('type を読む（省略すると plugin）', () => {
    const base = '"id":"sakura","name":"さくら","version":"1"';
    expect(parsePackageManifest(`{${base}}`).kind).toBe('plugin');
    expect(parsePackageManifest(`{${base},"type":"theme"}`).kind).toBe('theme');
    // manifest 自体には type を入れない（プラグインの this.manifest は今までどおり）
    expect(parsePackageManifest(`{${base},"type":"theme"}`).manifest).not.toHaveProperty('type');
    expect(() => parsePackageManifest(`{${base},"type":"skin"}`)).toThrow();
  });
});

describe('themeHost', () => {
  beforeEach(() => {
    themeHost.select(null);
    themeHost.sync([], [], true);
    pluginFile.mockClear();
  });

  it('選んだテーマを <style> で入れ、外すと消す', async () => {
    themeHost.sync([server('sakura', 'h1'), server('dice', 'h2', 'plugin')], [], true);
    expect(styleText()).toBeNull();

    themeHost.select('sakura');
    await flush();
    expect(pluginFile).toHaveBeenCalledWith('sakura', 'theme.css', 'h1');
    expect(styleText()).toBe(':root{--accent:h1}');
    expect(themeHost.applied).toBe('sakura');
    // 本体の CSS より後ろ（head の最後）に置く
    expect(document.head.lastElementChild?.matches(THEME_STYLE_SELECTOR)).toBe(true);

    // 更新されたら入れ替える
    themeHost.sync([server('sakura', 'h3')], [], true);
    await flush();
    expect(styleText()).toBe(':root{--accent:h3}');

    // プラグインは選べない（テーマとして扱わない）
    themeHost.select('dice');
    await flush();
    expect(styleText()).toBeNull();
    expect(themeHost.applied).toBeNull();
  });

  it('開発用フォルダのものを優先し、保存のたびに読み直す', async () => {
    themeHost.select('sakura');
    themeHost.sync([server('sakura', 'h1')], [dev('sakura', 's1', 'a{}')], true);
    await flush();
    expect(styleText()).toBe('a{}');
    expect(pluginFile).not.toHaveBeenCalled();

    themeHost.sync([server('sakura', 'h1')], [dev('sakura', 's2', 'b{}')], true);
    await flush();
    expect(styleText()).toBe('b{}');
  });

  it('消えたら外す。開発用フォルダを読む前は外さない', async () => {
    themeHost.select('night');
    themeHost.sync([], [dev('night', 's1', 'n{}')], true);
    await flush();
    expect(styleText()).toBe('n{}');

    themeHost.sync([], [], false);
    await flush();
    expect(styleText()).toBe('n{}');

    themeHost.sync([], [], true);
    await flush();
    expect(styleText()).toBeNull();
    // 選んだことは覚えておく（配布し直されたらまた使う）
    expect(themeHost.selected).toBe('night');
  });
});
