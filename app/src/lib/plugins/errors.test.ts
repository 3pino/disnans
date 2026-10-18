// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../transport/http';
import { PluginError, VersionConflictError, plainPluginErrors, toPluginError } from './errors';
import { PluginBase, PluginRuntime } from './runtime';
import { isVersionConflict } from './types';
import type { HostServices, Manifest, PluginClass } from './types';

describe('PluginError', () => {
  it('code と message を持つ。name は PluginError', () => {
    const e = new PluginError('stopped', 'もう使えません');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PluginError');
    expect(e.code).toBe('stopped');
    expect(e.message).toBe('もう使えません');
  });

  it('VersionConflictError は PluginError の一種で、code は version_conflict', () => {
    const e = new VersionConflictError();
    expect(e).toBeInstanceOf(PluginError);
    expect(e).toBeInstanceOf(VersionConflictError);
    expect(e.code).toBe('version_conflict');
    expect(e.name).toBe('VersionConflictError');
  });
});

describe('toPluginError', () => {
  it('PluginError はそのまま返す', () => {
    const e = new PluginError('not_found', 'x');
    expect(toPluginError(e)).toBe(e);
  });

  it('サーバーのエラーは、サーバーの code をそのまま使う', () => {
    const e = toPluginError(new HttpError(404, 'not_found', 'ありません'));
    expect(e).toBeInstanceOf(PluginError);
    expect(e.code).toBe('not_found');
  });

  it('サーバーの version_conflict は VersionConflictError になる', () => {
    const e = toPluginError(new HttpError(409, 'version_conflict', 'ぶつかりました'));
    expect(e).toBeInstanceOf(VersionConflictError);
    expect(e.code).toBe('version_conflict');
  });

  it('届かなかった通信（fetch の失敗）は disconnected', () => {
    expect(toPluginError(new TypeError('Failed to fetch')).code).toBe('disconnected');
  });

  it('それ以外は既定の code（既定は failed）、message を引き継ぐ', () => {
    expect(toPluginError(new Error('x')).code).toBe('failed');
    const e = toPluginError(new Error('x'), 'invalid_argument');
    expect(e.code).toBe('invalid_argument');
    expect(e.message).toBe('x');
  });

  it('文字列の例外も message にする', () => {
    expect(toPluginError('boom').message).toBe('boom');
  });
});

describe('plainPluginErrors', () => {
  it('サーバーを呼ぶ関数の失敗を PluginError にそろえる（成功はそのまま）', async () => {
    const ok = plainPluginErrors(async (n: number) => n + 1);
    await expect(ok(1)).resolves.toBe(2);
    const bad = plainPluginErrors(async () => {
      throw new HttpError(400, 'invalid_plugin_id', '不正です');
    });
    await expect(bad()).rejects.toMatchObject({ code: 'invalid_plugin_id' });
  });
});

describe('isVersionConflict', () => {
  it('HttpError でも PluginError でも code で見分ける', () => {
    expect(isVersionConflict(new HttpError(409, 'version_conflict', 'x'))).toBe(true);
    expect(isVersionConflict(new VersionConflictError())).toBe(true);
    expect(isVersionConflict(new HttpError(409, 'other', 'x'))).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
  });
});

describe('本体の例外の code（PluginRuntime）', () => {
  const manifest: Manifest = { id: 'x', name: 'X', version: '1', description: '', author: '', minApiVersion: 14 };
  const services = {
    app: {},
    api: {},
    send: vi.fn(),
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: () => () => {},
    openPanel: vi.fn(),
    openSettings: vi.fn(),
    closePanel: vi.fn(),
    toast: vi.fn(),
    storage: { get: () => null, set: () => {} },
    pluginIcon: () => 'puzzle',
    registerIcon: () => () => {},
    registerStatusItem: () => () => {},
    holdBackground: async () => Object.assign(() => {}, { update: () => {} }),
    changed: vi.fn(),
  } as unknown as HostServices;

  it('messages と messageIds の両方は invalid_argument', async () => {
    class P extends PluginBase {}
    const r = new PluginRuntime(manifest, services);
    await r.start(P as PluginClass);
    const p = r.instance as PluginBase;
    let caught: unknown = null;
    try {
      p.openTimeline({ title: 't', messages: [], messageIds: [] } as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid_argument');
  });

  it('外したあとの openSettings は失敗にしない（従来どおり何もしない）', async () => {
    class P extends PluginBase {}
    const r = new PluginRuntime(manifest, services);
    await r.start(P as PluginClass);
    const p = r.instance as P;
    r.stop();
    expect(() => p.openSettings()).not.toThrow();
  });

  it('new Plugin で作ると invalid_argument', () => {
    let caught: unknown = null;
    try {
      new PluginBase();
    } catch (e) {
      caught = e;
    }
    expect((caught as PluginError).code).toBe('invalid_argument');
  });
});
