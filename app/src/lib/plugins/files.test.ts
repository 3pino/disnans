// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { checkSharedPath, hasPermission, parentOf, PluginFiles } from './files';
import { PluginError } from './errors';
import { PluginBase, PluginRuntime } from './runtime';
import { parseManifest, permissionsOf } from './manifest';
import { HttpError } from '../transport/http';
import type { SharedApi } from '../transport/shared';
import type { SharedEntry } from '../protocol/SharedEntry';
import type { HostServices, Manifest, PluginClass } from './types';

const entry = (path: string, kind: 'file' | 'dir' = 'file', over: Partial<SharedEntry> = {}): SharedEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: kind === 'dir' ? 0 : 3,
  modified: 1_700_000_000_000,
  mime: null,
  message_id: null,
  ...over,
});

/** 共有フォルダの手元の模型（呼ばれた引数を覚える） */
function fakeApi(entries: SharedEntry[] = []) {
  const calls: [string, ...unknown[]][] = [];
  const api: SharedApi = {
    list: vi.fn(async (path: string) => {
      calls.push(['list', path]);
      return entries.filter((e) => parentOf(e.path) === path);
    }),
    read: vi.fn(async (path: string) => {
      calls.push(['read', path]);
      return new Blob(['abc']);
    }),
    write: vi.fn(async (path: string, body: unknown) => {
      calls.push(['write', path, body]);
      return entry(path);
    }),
    mkdir: vi.fn(async (path: string) => {
      calls.push(['mkdir', path]);
      return entry(path, 'dir');
    }),
    remove: vi.fn(async (path: string) => {
      calls.push(['remove', path]);
    }),
    move: vi.fn(async (from: string, to: string) => {
      calls.push(['move', from, to]);
      return entry(to);
    }),
    copy: vi.fn(async (from: string, to: string) => {
      calls.push(['copy', from, to]);
      return entry(to);
    }),
  };
  return { api, calls };
}

const noSubscribe = () => () => {};

/** 権限のあるもの */
function allowed(entries: SharedEntry[] = []) {
  const f = fakeApi(entries);
  const files = new PluginFiles(true, f.api, noSubscribe);
  return { files, ...f };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PluginError);
    return (e as PluginError).code;
  }
  throw new Error('失敗しなかった');
}

describe('パスの決まり', () => {
  it('直下（空）は list だけ。区切りの空・. ・.. は invalid_argument', () => {
    expect(checkSharedPath('', true)).toBe('');
    expect(checkSharedPath('docs/a.txt')).toBe('docs/a.txt');
    expect(() => checkSharedPath('')).toThrow(PluginError);
    for (const bad of ['/a', 'a/', 'a//b', 'a/./b', 'a/../b', '..']) {
      expect(() => checkSharedPath(bad), bad).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    }
    expect(() => checkSharedPath(3 as unknown as string)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('親のフォルダ', () => {
    expect(parentOf('a.txt')).toBe('');
    expect(parentOf('docs/a.txt')).toBe('docs');
    expect(parentOf('x/y/z')).toBe('x/y');
  });
});

describe('権限（manifest.json の permissions）', () => {
  it('"files" があるときだけ使える（ほかの名前は関係ない）', () => {
    expect(hasPermission(['files'], 'files')).toBe(true);
    expect(hasPermission(['net'], 'files')).toBe(false);
    expect(hasPermission(undefined, 'files')).toBe(false);
  });

  it('権限がなければ、どの操作も permission_denied（呼ぶと非同期で失敗・onChange は同期で投げる）', async () => {
    const f = fakeApi([entry('a.txt')]);
    const files = new PluginFiles(false, f.api, noSubscribe);
    const calls = [
      files.list(),
      files.stat('a.txt'),
      files.read('a.txt'),
      files.write('b.txt', 'x'),
      files.mkdir('d'),
      files.remove('a.txt'),
      files.move('a.txt', 'b.txt'),
      files.copy('a.txt', 'b.txt'),
    ];
    for (const p of calls) expect(await codeOf(p)).toBe('permission_denied');
    expect(() => files.onChange(() => {})).toThrow(expect.objectContaining({ code: 'permission_denied' }));
    expect(f.calls).toEqual([]);
  });
});

describe('操作（権限あり）', () => {
  it('list は直下と、フォルダの中身を返す（空は直下）', async () => {
    const { files, calls } = allowed([entry('a.txt'), entry('docs', 'dir'), entry('docs/b.txt')]);
    expect((await files.list()).map((e) => e.path)).toEqual(['a.txt', 'docs']);
    expect((await files.list('docs')).map((e) => e.path)).toEqual(['docs/b.txt']);
    expect(calls).toEqual([
      ['list', ''],
      ['list', 'docs'],
    ]);
  });

  it('stat は親の一覧から探す。なければ not_found', async () => {
    const { files } = allowed([entry('docs', 'dir'), entry('docs/b.txt', 'file', { size: 42 })]);
    expect(await files.stat('docs/b.txt')).toMatchObject({ path: 'docs/b.txt', size: 42, kind: 'file' });
    expect(await codeOf(files.stat('docs/none.txt'))).toBe('not_found');
  });

  it('read は Blob。フォルダは invalid_argument（一覧の JSON を読まない）', async () => {
    const { files, calls } = allowed([entry('docs', 'dir'), entry('docs/a.txt')]);
    const blob = await files.read('docs/a.txt');
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe('abc');
    expect(await codeOf(files.read('docs'))).toBe('invalid_argument');
    expect(calls.find((c) => c[0] === 'read')).toEqual(['read', 'docs/a.txt']);
    expect(calls.some((c) => c[0] === 'read' && c[1] === 'docs')).toBe(false);
  });

  it('write は Blob・ArrayBuffer・文字列を渡す。ほかの型は invalid_argument', async () => {
    const { files, calls } = allowed();
    const blob = new Blob(['x']);
    await files.write('a.txt', blob);
    await files.write('b.txt', new ArrayBuffer(2));
    await files.write('c.txt', 'text');
    expect(calls.map((c) => c[2])).toEqual([blob, expect.any(ArrayBuffer), 'text']);
    expect(await codeOf(files.write('d.txt', 12 as unknown as string))).toBe('invalid_argument');
  });

  it('mkdir・remove・move・copy はそのまま渡す', async () => {
    const { files, calls } = allowed();
    expect((await files.mkdir('docs')).kind).toBe('dir');
    await files.remove('docs');
    await files.move('a.txt', 'docs/a.txt');
    await files.copy('docs/a.txt', 'b.txt');
    expect(calls).toEqual([
      ['mkdir', 'docs'],
      ['remove', 'docs'],
      ['move', 'a.txt', 'docs/a.txt'],
      ['copy', 'docs/a.txt', 'b.txt'],
    ]);
  });

  it('サーバーの code はそのまま PluginError の code になる', async () => {
    const { files, api } = allowed();
    for (const code of ['not_found', 'forbidden', 'exists', 'parent_missing', 'too_large', 'insufficient_storage']) {
      (api.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new HttpError(409, code, '失敗'));
      expect(await codeOf(files.write('x.txt', 'x')), code).toBe(code);
    }
  });

  it('届かなかった通信は disconnected', async () => {
    const { files, api } = allowed();
    (api.mkdir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await codeOf(files.mkdir('x'))).toBe('disconnected');
  });

  it('パスの間違いは、サーバーに送らずに invalid_argument', async () => {
    const { files, api } = allowed();
    expect(await codeOf(files.read('../x'))).toBe('invalid_argument');
    expect(await codeOf(files.move('', 'x'))).toBe('invalid_argument');
    expect(api.move).not.toHaveBeenCalled();
  });
});

describe('onChange', () => {
  it('変わったパスを { path } で渡す。解除すると届かない', () => {
    let fire: ((path: string) => void) | null = null;
    const off = vi.fn();
    const files = new PluginFiles(true, fakeApi().api, (cb) => {
      fire = cb;
      return off;
    });
    const got: string[] = [];
    const stop = files.onChange((ev) => got.push(ev.path));
    fire!('docs/a.txt');
    expect(got).toEqual(['docs/a.txt']);
    stop();
    expect(off).toHaveBeenCalled();
  });

  it('cb が関数でなければ invalid_argument', () => {
    const files = new PluginFiles(true, fakeApi().api, noSubscribe);
    expect(() => files.onChange(3 as unknown as () => void)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });
});

describe('プラグインの本体との結び（PluginRuntime）', () => {
  const base: Manifest = { id: 'notes', name: 'メモ', version: '1.0.0', description: '', author: 'me', minApiVersion: 15 };

  function services(entries: SharedEntry[] = []) {
    const f = fakeApi(entries);
    const listeners = new Set<(p: string) => void>();
    const services = {
      app: {},
      files: {
        api: f.api,
        onChanged: (cb: (p: string) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      closePanel: vi.fn(),
      changed: vi.fn(),
    } as unknown as HostServices;
    return { services, f, emit: (p: string) => listeners.forEach((cb) => cb(p)), count: () => listeners.size };
  }

  it('permissions に "files" があれば this.files が使え、無ければ permission_denied', async () => {
    const s = services([entry('a.txt')]);
    let got: unknown = null;
    class P extends PluginBase {
      async onload() {
        got = await this.files.list();
      }
    }
    const withPerm = new PluginRuntime({ ...base, permissions: ['files'] }, s.services);
    await withPerm.start(P as PluginClass);
    expect((got as SharedEntry[]).map((e) => e.path)).toEqual(['a.txt']);

    class Q extends PluginBase {
      async onload() {
        got = await codeOf(this.files.list());
      }
    }
    const without = new PluginRuntime(base, s.services);
    await without.start(Q as PluginClass);
    expect(got).toBe('permission_denied');
  });

  it('onChange の受け取りは、プラグインを外すと解除される', async () => {
    const s = services();
    let seen: string[] = [];
    class P extends PluginBase {
      onload() {
        this.files.onChange((ev) => seen.push(ev.path));
      }
    }
    const r = new PluginRuntime({ ...base, permissions: ['files'] }, s.services);
    await r.start(P as PluginClass);
    s.emit('a.txt');
    expect(seen).toEqual(['a.txt']);
    expect(s.count()).toBe(1);
    r.stop();
    expect(s.count()).toBe(0);
    s.emit('b.txt');
    expect(seen).toEqual(['a.txt']);
  });
});

describe('manifest の permissions', () => {
  const json = (extra: Record<string, unknown>) =>
    JSON.stringify({ id: 'notes', name: 'メモ', version: '1.0.0', ...extra });

  it('省略は未設定。配列の文字列は読む（重複は1つ）。知らない名前は残すだけ', () => {
    expect(parseManifest(json({})).permissions).toBeUndefined();
    expect(parseManifest(json({ permissions: ['files', 'files', 'future'] })).permissions).toEqual(['files', 'future']);
  });

  it('配列でない・文字列でない要素は読めない', () => {
    expect(() => parseManifest(json({ permissions: 'files' }))).toThrow(/permissions/);
    expect(() => parseManifest(json({ permissions: ['files', 3] }))).toThrow(/permissions/);
  });

  it('permissionsOf は読めないとき空', () => {
    expect(permissionsOf(json({ permissions: ['files'] }))).toEqual(['files']);
    expect(permissionsOf('{')).toEqual([]);
    expect(permissionsOf(json({}))).toEqual([]);
  });
});
