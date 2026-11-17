// @vitest-environment jsdom
// ホスト API の版（19）と、プラグインの minApiVersion の関係: 17 以下の古いプラグインは今までどおり読み込み、
// 本体より新しい版（20）を求めるものは読み込まず、アプリの更新を促す
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../call/instance.svelte', () => ({ callApi: {} }));

import { PluginHost } from './host.svelte';
import { API_VERSION } from './types';

function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

let scripts: string[] = [];
let reading: Promise<unknown>[] = [];

beforeEach(() => {
  scripts = [];
  reading = [];
  let n = 0;
  URL.createObjectURL = vi.fn((b: Blob) => {
    reading.push(readBlob(b).then((text) => scripts.push(text)));
    return `blob:fake/${++n}`;
  });
  URL.revokeObjectURL = vi.fn();
});

async function loadWith(id: string, minApiVersion: number): Promise<PluginHost> {
  const host = new PluginHost();
  const wanted = {
    sig: `server:h-${id}`,
    manifest: { id, name: id, version: '1.0.0', description: '', author: '', minApiVersion },
    load: async () => ({ main: `export default class {} /* main ${id} */`, styles: null, permissions: [] }),
  };
  await (host as unknown as { load(id: string, w: unknown): Promise<void> }).load(id, wanted);
  await Promise.all(reading);
  return host;
}

describe('ホスト API の版', () => {
  it('本体の版は 19', () => {
    expect(API_VERSION).toBe(19);
  });

  it.each([2, 9, 17, 18, 19])('minApiVersion %i のプラグインは読み込む', async (min) => {
    const host = await loadWith(`p${min}`, min);
    expect(scripts.some((t) => t.includes(`main p${min}`))).toBe(true);
    // 版の判定では止まらない（import の失敗は、このテストの偽の Blob URL のため）
    expect(host.errors[`p${min}`] ?? '').not.toContain('ホスト API');
  });

  it('minApiVersion 20（本体より新しい）は読み込まず、版を示して更新を促す', async () => {
    const host = await loadWith('p20', 20);
    expect(scripts).toEqual([]);
    expect(host.errors['p20']).toContain('v19');
    expect(host.errors['p20']).toContain('v20');
    expect(host.errors['p20']).toContain('アプリを更新');
  });
});
