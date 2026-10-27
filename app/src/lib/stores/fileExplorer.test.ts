import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('../transport/shared', () => ({ sharedApi: { list: (p: string) => list(p) } }));

import { fileExplorer } from './fileExplorer.svelte';
import { sharedIndex } from './sharedIndex.svelte';

const entry = (name: string) => ({ name, path: name, kind: 'file', size: 1, modified: 0, mime: null, message_id: null, file_id: null });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('fileExplorer', () => {
  beforeEach(() => {
    list.mockReset();
    sharedIndex.invalidate('');
    sharedIndex.invalidate('docs');
    fileExplorer.dir = '';
    fileExplorer.forgetHistory();
  });

  it('開くと一覧を読み、up で親へ戻る。直下の up は false', async () => {
    list.mockResolvedValue([entry('a.txt')]);
    fileExplorer.open('docs');
    expect(fileExplorer.state?.kind).toBe('loading');
    await flush();
    expect(fileExplorer.state?.kind).toBe('ok');
    expect(fileExplorer.up()).toBe(true);
    expect(fileExplorer.dir).toBe('');
    expect(fileExplorer.up()).toBe(false);
  });

  it('戻る（back）は、前に開いていたフォルダへ（親ではなく、開いた順に戻る）。履歴が無ければ false', () => {
    list.mockResolvedValue([]);
    fileExplorer.open('a/b/c');
    fileExplorer.open('x');
    fileExplorer.open('x'); // 同じフォルダは積まない
    expect(fileExplorer.back()).toBe(true);
    expect(fileExplorer.dir).toBe('a/b/c');
    expect(fileExplorer.back()).toBe(true);
    expect(fileExplorer.dir).toBe('');
    expect(fileExplorer.back()).toBe(false);
  });

  it('失敗は error になり、reload で読み直せる', async () => {
    list.mockRejectedValueOnce(new Error('boom'));
    fileExplorer.open('docs');
    await flush();
    expect(fileExplorer.state).toEqual({ kind: 'error', message: 'boom' });
    list.mockResolvedValue([]);
    fileExplorer.reload();
    await flush();
    expect(fileExplorer.state?.kind).toBe('ok');
  });

  it('files.changed（invalidate）で捨てられる', async () => {
    list.mockResolvedValue([]);
    fileExplorer.open('docs');
    await flush();
    sharedIndex.invalidate('docs/new.txt');
    expect(fileExplorer.state).toBeUndefined();
  });
});

describe('接続先の切り替え', () => {
  it('旧サーバーの一覧と場所を捨てる', async () => {
    const { applyServerUrl: setServerUrl } = await import('../config');
    setServerUrl('http://a.example');
    list.mockResolvedValue([]);
    fileExplorer.open('docs');
    await flush();
    setServerUrl('http://b.example');
    expect(fileExplorer.dir).toBe('');
    expect(sharedIndex.state('docs')).toBeUndefined();
    setServerUrl(null);
  });
});
