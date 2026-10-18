import { describe, expect, it } from 'vitest';
import { manifestOf, parseManifest } from './manifest';
import type { PluginInfo } from '../protocol/PluginInfo';

const base = { id: 'dice', name: 'ダイス', version: '1.0.0' };

describe('parseManifest の apiVersion', () => {
  it('省略できる（minApiVersion とみなす）', () => {
    const m = parseManifest(JSON.stringify({ ...base, minApiVersion: 12 }));
    expect(m.apiVersion).toBeUndefined();
    expect(m.minApiVersion).toBe(12);
  });

  it('書いたら読む', () => {
    const m = parseManifest(JSON.stringify({ ...base, minApiVersion: 12, apiVersion: 13 }));
    expect(m.apiVersion).toBe(13);
  });

  it('0 や負の値は読まない（1 以上の整数）', () => {
    expect(() => parseManifest(JSON.stringify({ ...base, minApiVersion: 0, apiVersion: 0 }))).toThrow('apiVersion');
    expect(() => parseManifest(JSON.stringify({ ...base, minApiVersion: 0, apiVersion: -1 }))).toThrow('apiVersion');
  });

  it('minApiVersion より小さい・整数でない値は読まない', () => {
    expect(() => parseManifest(JSON.stringify({ ...base, minApiVersion: 12, apiVersion: 11 }))).toThrow('apiVersion');
    expect(() => parseManifest(JSON.stringify({ ...base, minApiVersion: 12, apiVersion: 13.5 }))).toThrow('apiVersion');
    expect(() => parseManifest(JSON.stringify({ ...base, minApiVersion: 12, apiVersion: '13' }))).toThrow('apiVersion');
  });
});

describe('manifestOf', () => {
  const info = {
    id: 'dice',
    name: 'ダイス',
    version: '1.0.0',
    description: '',
    author: '',
    min_api_version: 12,
    api_version: null,
    icon: null,
  } as unknown as PluginInfo;

  it('サーバーの api_version が null なら apiVersion は付かない', () => {
    expect(manifestOf(info)).not.toHaveProperty('apiVersion');
  });

  it('api_version があれば apiVersion になる', () => {
    expect(manifestOf({ ...info, api_version: 13 } as PluginInfo).apiVersion).toBe(13);
  });
});
