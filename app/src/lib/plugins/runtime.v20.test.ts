// @vitest-environment jsdom
// API 20: registerView の任意の設定（layout: 'full' は全画面の view）。openView は、全画面かどうかを本体へ渡す。
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import type { HostServices, Manifest } from './types';

const manifest: Manifest = { id: 'files', name: 'ファイル', version: '1.0.0', description: '', author: 'test', minApiVersion: 20 };

function services() {
  const store = new Map<string, string>();
  return {
    app: { me: { id: 'u1', login_name: 'a', display_name: 'A', avatar_url: null }, users: [], user: () => undefined, nameOf: (id: string) => id, isMobile: false, theme: 'light' },
    api: { createSession: vi.fn(), getSession: vi.fn(), updateSession: vi.fn(), notify: vi.fn(), postMessage: vi.fn() },
    send: vi.fn(),
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: () => () => {},
    registerMessageAction: () => () => {},
    findMessage: () => undefined,
    openTimeline: vi.fn(),
    openPanel: vi.fn(),
    openSettings: vi.fn(),
    closePanel: vi.fn(),
    toast: vi.fn(),
    storage: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string | null) => (v === null ? store.delete(k) : store.set(k, v)) },
    pluginIcon: () => 'puzzle',
    registerIcon: () => () => {},
    registerStatusItem: () => () => {},
    presence: vi.fn(),
    holdBackground: async () => Object.assign(() => {}, { update: () => {} }),
    files: { api: {} as never, onChanged: () => () => {} },
    legacyData: vi.fn(() => null),
    markLegacyTaken: vi.fn(),
    changed: vi.fn(),
  } as unknown as HostServices & { openPanel: ReturnType<typeof vi.fn> };
}

describe('registerView の layout（API 20）', () => {
  it("layout: 'full' の view は全画面として登録される。省略は従来どおり", async () => {
    class P extends PluginBase {
      onload() {
        this.registerView('browse', () => ({ onOpen() {} }), { layout: 'full' });
        this.registerView('plain', () => ({ onOpen() {} }));
      }
    }
    const r = new PluginRuntime(manifest, services());
    await r.start(P);
    expect(r.isFullView('browse')).toBe(true);
    expect(r.isFullView('plain')).toBe(false);
  });

  it('openView は、全画面の view かどうかを本体へ渡す（パネルの枠は本体が決める）', async () => {
    class P extends PluginBase {
      onload() {
        this.registerView('browse', () => ({ onOpen() {} }), { layout: 'full' });
        this.registerView('plain', () => ({ onOpen() {} }));
      }
    }
    const svc = services();
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    (r.instance as P).openView('browse');
    expect(svc.openPanel).toHaveBeenCalledWith('files', 'browse', null);
  });

  it('layout に知らない値を渡すと、登録できない（invalid_argument）', async () => {
    class P extends PluginBase {
      onload() {
        this.registerView('bad', () => ({ onOpen() {} }), { layout: 'half' } as never);
      }
    }
    const r = new PluginRuntime(manifest, services());
    await expect(r.start(P)).rejects.toThrow("layout は 'full' だけ");
    expect(r.views.has('bad')).toBe(false);
  });

  it('プラグインが外れると、全画面の印も消える', async () => {
    class P extends PluginBase {
      onload() {
        this.registerView('browse', () => ({ onOpen() {} }), { layout: 'full' });
      }
    }
    const r = new PluginRuntime(manifest, services());
    await r.start(P);
    expect(r.isFullView('browse')).toBe(true);
    r.stop();
    expect(r.isFullView('browse')).toBe(false);
  });
});
