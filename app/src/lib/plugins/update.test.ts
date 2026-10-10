import { describe, expect, it } from 'vitest';
import { hasPluginUpdate, localVersion, pluginUpdateText } from './update';
import type { PluginEntry } from './host.svelte';

// テスト用の一覧の1件（必要な項目だけ）
function entry(local: string | null, server: { version: string; hash: string; visibility: 'public' | 'private' } | null): PluginEntry {
  return {
    id: 'demo',
    manifest: null,
    server,
    dev: local === null ? null : { kind: 'plugin', folder: 'demo', manifest: { version: local } },
    enabled: true,
    loaded: false,
    error: null,
    hasSettings: false,
    icon: 'puzzle',
  } as unknown as PluginEntry;
}

const pub = { version: '1.0.0', hash: 'h1', visibility: 'public' as const };

describe('hasPluginUpdate', () => {
  it('手元が新しい版ならアップデートがある', () => {
    expect(hasPluginUpdate(entry('1.1.0', pub), null)).toBe(true);
  });
  it('版が同じで中身が違えばアップデートがある', () => {
    expect(hasPluginUpdate(entry('1.0.0', pub), 'h2')).toBe(true);
  });
  it('版も中身も同じならアップデートはない', () => {
    expect(hasPluginUpdate(entry('1.0.0', pub), 'h1')).toBe(false);
  });
  it('中身のハッシュが計算できなければ、版だけで判断する', () => {
    expect(hasPluginUpdate(entry('1.0.0', pub), null)).toBe(false);
  });
  it('手元が古いならアップデートはない', () => {
    expect(hasPluginUpdate(entry('0.9.0', pub), 'h2')).toBe(false);
  });
  it('手元がない、または配布済みがないなら、アップデートはない', () => {
    expect(hasPluginUpdate(entry(null, pub), 'h2')).toBe(false);
    expect(hasPluginUpdate(entry('2.0.0', null), 'h2')).toBe(false);
  });
});

describe('localVersion / pluginUpdateText', () => {
  it('手元の版が読めなければ空', () => {
    expect(localVersion(entry(null, pub))).toBe('');
  });
  it('説明に配布先と版を書く', () => {
    expect(pluginUpdateText(entry('1.1.0', { ...pub, visibility: 'private' }))).toBe('v1.0.0 → v1.1.0（自分だけに配布）');
  });
  it('版が同じなら中身が変わったことを書く', () => {
    expect(pluginUpdateText(entry('1.0.0', pub))).toBe('v1.0.0 → v1.0.0（版は同じで中身が変わりました）（みんなに配布）');
  });
});
