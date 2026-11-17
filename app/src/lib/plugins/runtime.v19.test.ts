// @vitest-environment jsdom
// API 19 の view（セッションのない view）と、旧い保存先の取り込み（legacyData。最初の saveData まで）
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import type { HostServices, Manifest } from './types';
import type { Session } from '../protocol/Session';

const manifest: Manifest = { id: 'files', name: 'ファイル', version: '1.0.0', description: '', author: 'test', minApiVersion: 19 };

function services(legacy: unknown = null) {
  const store = new Map<string, string>();
  const svc = {
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
    legacyData: vi.fn(() => legacy),
    markLegacyTaken: vi.fn(),
    changed: vi.fn(),
  };
  return svc as unknown as HostServices & typeof svc;
}

describe('セッションのない view（API 19）', () => {
  it('openView(type) で開くと、factory は session に null を受ける。mountView(null) も同じ', async () => {
    const seen: unknown[] = [];
    class P extends PluginBase {
      onload() {
        this.registerView('list', (s) => {
          seen.push(s);
          return { onOpen() {} };
        });
      }
    }
    const svc = services();
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    await r.mountView('list', null, document.createElement('div'));
    expect(seen).toEqual([null]);
  });

  it('openView(type) は sessionId なしで本体のパネルを開く（セッションを作らない）', async () => {
    class P extends PluginBase {
      onload() {
        this.registerView('list', () => ({ onOpen() {} }));
      }
    }
    const svc = services();
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    (r.instance as P).openView('list');
    expect(svc.openPanel).toHaveBeenCalledWith('files', 'list', null);
    expect(svc.api.createSession).not.toHaveBeenCalled();
    expect(svc.presence).not.toHaveBeenCalled();
  });

  it('セッションつきの view は今までどおり（factory は session を受け、プレゼンスを送る）', async () => {
    const seen: unknown[] = [];
    class P extends PluginBase {
      onload() {
        this.registerView('card', (s) => {
          seen.push(s);
          return { onOpen() {} };
        });
      }
    }
    const svc = services();
    const session = { id: 'S1', version: 1, state: {}, card: { title: '', text: '' } } as unknown as Session;
    (svc.api.getSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'S1', version: 1, state: {}, card: { title: '', text: '' }, messageId: null, viewers: [] });
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    (r.instance as P).openView('card', session as never);
    expect(svc.openPanel).toHaveBeenCalledWith('files', 'card', 'S1');
    await r.mountView('card', 'S1', document.createElement('div'));
    expect(seen.length).toBe(1);
    expect((seen[0] as { id: string }).id).toBe('S1');
    expect(svc.presence).toHaveBeenCalledWith('S1', true);
  });
});

describe('旧い保存先（legacyData）', () => {
  it('プラグインが最初に saveData するまで、本体の値を読める。保存したら印を付ける', async () => {
    class P extends PluginBase {}
    const svc = services({ '': { view: 'list' } });
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    const inst = r.instance as unknown as { legacyData: unknown; saveData(d: unknown): Promise<void> };
    expect(inst.legacyData).toEqual({ '': { view: 'list' } });
    await inst.saveData({ dirs: {} });
    expect(svc.markLegacyTaken).toHaveBeenCalledWith('files');
  });

  it('対象でなければ null。停止したあとも null', async () => {
    class P extends PluginBase {}
    const svc = services(null);
    const r = new PluginRuntime(manifest, svc);
    await r.start(P);
    expect((r.instance as unknown as { legacyData: unknown }).legacyData).toBeNull();
    r.stop();
    expect((r.instance as unknown as { legacyData: unknown }).legacyData).toBeNull();
  });
});
