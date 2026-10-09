// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { VersionConflictError } from './sessions';
import { parseHotkey, matchHotkey } from './hotkey';
import { parseManifest } from './manifest';
import type { HostCommand, HostServices, Manifest, PluginClass } from './types';
import type { Session as SessionData } from '../protocol/Session';
import type { ClientEvent } from '../protocol/ClientEvent';
import { hasIcon, lookupIcon, registerIcon, setLucideForTest } from '../icons.svelte';

const manifest: Manifest = {
  id: 'dice',
  name: 'ダイス',
  version: '1.0.0',
  description: '',
  author: 'test',
  minApiVersion: 1,
};

function sessionData(over: Partial<SessionData> = {}): SessionData {
  return {
    id: 's1',
    plugin: 'dice',
    message_id: 'm1',
    created_by: 'u1',
    state: { n: 0 },
    version: 1,
    card: { title: 'ダイス', text: '用意しました' },
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

class Conflict extends Error {
  status = 409;
  code = 'version_conflict';
}

/** 本体の機能の偽物。登録されたものを数えられるようにする */
function fakeServices() {
  const slash = new Set<string>();
  const actions = new Set<string>();
  const actionDefs = new Map<string, { id: string; icon?: unknown }>();
  const slashDefs = new Map<string, { name: string; icon?: unknown }>();
  const commands = new Map<string, HostCommand>();
  const sent: ClientEvent[] = [];
  const store = new Map<string, string>();
  let server = sessionData();
  const s = {
    slash,
    actionDefs,
    slashDefs,
    commands,
    actions,
    sent,
    store,
    get server() {
      return server;
    },
    set server(v: SessionData) {
      server = v;
    },
    services: {
      app: {
        me: { id: 'u1', login_name: 'a', display_name: 'A', avatar_url: null },
        users: [],
        user: (id: string) => (id === 'u2' ? { id: 'u2', login_name: 'b', display_name: 'B', avatar_url: null } : undefined),
        nameOf: (id: string) => id,
        isMobile: false,
        theme: 'light',
      },
      api: {
        createSession: vi.fn(async () => server),
        getSession: vi.fn(async () => server),
        updateSession: vi.fn(async (_id: string, body: { version: number; state: unknown }) => {
          if (body.version !== server.version) throw new Conflict('conflict');
          server = { ...server, version: server.version + 1, state: body.state };
          return server;
        }),
        notify: vi.fn(async () => {}),
      },
      send: (ev: ClientEvent) => void sent.push(ev),
      registerSlashCommand: (def: { name: string }) => {
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(def.name)) throw new Error('bad name');
        slash.add(def.name);
        slashDefs.set(def.name, def);
        return () => slash.delete(def.name);
      },
      registerComposerAction: (a: { id: string }) => {
        actions.add(a.id);
        actionDefs.set(a.id, a);
        return () => actions.delete(a.id);
      },
      registerCommand: (c: HostCommand) => {
        commands.set(c.id, c);
        return () => commands.delete(c.id);
      },
      openPanel: vi.fn(),
      closePanel: vi.fn(),
      toast: vi.fn(),
      storage: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string | null) => (v === null ? store.delete(k) : store.set(k, v)) },
      pluginIcon: () => 'puzzle',
      registerIcon,
      changed: vi.fn(),
    } as unknown as HostServices,
  };
  return s;
}

describe('PluginRuntime', () => {
  it('addIcon は外すと消え、アイコンを省いた項目はプラグインのアイコンになる', async () => {
    const f = fakeServices();
    class P extends PluginBase {
      onload() {
        this.addIcon('dice-test-cup', '<path d="M4 4h16v16H4z"/>');
        this.addIcon('dice-test-bad', '<path');
        this.addComposerAction({ id: 'a', label: 'A', run: () => {} });
        this.addComposerAction({ id: 'b', label: 'B', icon: 'dice-test-cup', run: () => {} });
        this.addSlashCommand({ name: 'c', description: '', run: () => {} });
        this.addSlashCommand({ name: 'd', description: '', icon: 'dice-5', run: () => {} });
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    expect(hasIcon('dice-test-cup')).toBe(true);
    // 読めない SVG はエラーとして持って動き続ける
    expect(r.errors).toHaveLength(1);
    expect(f.actionDefs.get('plugin:dice:a')?.icon).toBe('puzzle');
    expect(f.actionDefs.get('plugin:dice:b')?.icon).toBe('dice-test-cup');
    expect(f.slashDefs.get('c')?.icon).toBe('puzzle');
    expect(f.slashDefs.get('d')?.icon).toBe('dice-5');
    r.stop();
    setLucideForTest({});
    expect(lookupIcon('dice-test-cup')).toBeNull();
    setLucideForTest(null);
  });

  it('view はパネルの題名・アイコンを決められる（setTitle / setIcon）', async () => {
    const f = fakeServices();
    let panel: Disnans.ViewPanel | null = null;
    class P extends PluginBase {
      onload() {
        this.registerView('dice', () => ({
          title: '題名',
          onOpen: (_el: HTMLElement, p: Disnans.ViewPanel) => {
            panel = p;
          },
        }));
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    const headers: unknown[] = [];
    const handle = await r.mountView('dice', 's1', document.createElement('div'), (h) => headers.push(h));
    expect(headers).toEqual([{ title: '題名', icon: null }]);
    panel!.setIcon('dice-5');
    panel!.setTitle('');
    panel!.setTitle(null);
    expect(headers.slice(1)).toEqual([
      { title: '題名', icon: 'dice-5' },
      { title: '', icon: 'dice-5' },
      { title: '題名', icon: 'dice-5' },
    ]);
    handle.close();
    panel!.setTitle('閉じたあと');
    expect(headers).toHaveLength(4);
  });

  it('読み込んで登録したものは、外すとすべて片付く', async () => {
    const f = fakeServices();
    const onClose = vi.fn();
    const onunload = vi.fn();
    const domCb = vi.fn();
    const cleanup = vi.fn();
    const intervalCb = vi.fn();

    class P extends PluginBase {
      onload() {
        this.addSlashCommand({ name: 'dice', description: '', run: () => {} });
        this.addComposerAction({ id: 'roll', label: '振る', run: () => {} });
        this.addCommand({ id: 'quick', name: 'すぐ振る', hotkey: 'Mod+Shift+D', run: () => {} });
        this.addSettingTab({ display: () => {} });
        this.registerView('dice', () => ({ onOpen: () => {}, onClose }));
        this.registerCardRenderer(() => {});
        this.registerDomEvent(document, 'click', domCb);
        this.registerInterval(window.setInterval(intervalCb, 10));
        this.register(cleanup);
      }
      onunload() {
        onunload();
      }
    }

    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    expect(f.slash.has('dice')).toBe(true);
    expect(f.actions.has('plugin:dice:roll')).toBe(true);
    expect(f.commands.has('dice:quick')).toBe(true);
    expect(r.settingTabs).toHaveLength(1);
    expect(r.defaultViewType()).toBe('dice');
    expect(r.cardRenderer).not.toBeNull();

    const el = document.createElement('div');
    const handle = await r.mountView('dice', 's1', el);
    expect(handle.closed).toBe(false);

    r.stop();
    expect(onunload).toHaveBeenCalledOnce();
    expect(f.slash.size).toBe(0);
    expect(f.actions.size).toBe(0);
    expect(f.commands.size).toBe(0);
    expect(r.settingTabs).toHaveLength(0);
    expect(r.views.size).toBe(0);
    expect(r.cardRenderer).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(handle.closed).toBe(true);
    expect(f.services.closePanel).toHaveBeenCalledWith('dice');

    document.dispatchEvent(new Event('click'));
    expect(domCb).not.toHaveBeenCalled();
    await new Promise((res) => setTimeout(res, 30));
    expect(intervalCb).not.toHaveBeenCalled();
  });

  it('this.app / this.manifest はインスタンスごとの文脈から読む', async () => {
    const f = fakeServices();
    let seen: { me: string; id: string } | null = null;
    class P extends PluginBase {
      onload() {
        seen = { me: this.app.me.id, id: this.manifest.id };
      }
    }
    await new PluginRuntime(manifest, f.services).start(P as PluginClass);
    expect(seen).toEqual({ me: 'u1', id: 'dice' });
    // 本体の外で new することはできない
    expect(() => new P()).toThrow();
  });

  it('onload の例外はそのまま投げ、Plugin を継承していなければ読み込まない', async () => {
    const f = fakeServices();
    class Bad extends PluginBase {
      onload() {
        throw new Error('壊れている');
      }
    }
    await expect(new PluginRuntime(manifest, f.services).start(Bad as PluginClass)).rejects.toThrow('壊れている');
    class NotPlugin {}
    await expect(new PluginRuntime(manifest, f.services).start(NotPlugin as unknown as PluginClass)).rejects.toThrow();
    await expect(new PluginRuntime(manifest, f.services).start(undefined as unknown as PluginClass)).rejects.toThrow();
  });

  it('スラッシュコマンドの名前が正しくなければ、エラーとして持って動き続ける', async () => {
    const f = fakeServices();
    class P extends PluginBase {
      onload() {
        this.addSlashCommand({ name: 'Bad Name', description: '', run: () => {} });
        this.addSlashCommand({ name: 'ok', description: '', run: () => {} });
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    expect(r.errors).toHaveLength(1);
    expect(f.slash.has('ok')).toBe(true);
  });

  it('addCommand: ID にプラグイン ID を付け、読めないショートカット・スラッシュコマンド名はエラーにして外して登録する', async () => {
    const f = fakeServices();
    const run = vi.fn();
    class P extends PluginBase {
      onload() {
        this.addCommand({ id: 'a', name: 'A', hotkey: 'Mod+Shift+D', slash: 'roll', args: '[n]', suggestArgs: () => [{ value: '1' }], run });
        this.addCommand({ id: 'b', name: 'B', icon: 'dice-5', hotkey: 'Foo+X', slash: 'Bad Name', run: () => {} });
        this.addCommand({ id: 'c', name: 'C', suggestArgs: () => { throw new Error('x'); }, run: () => {} });
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    const a = f.commands.get('dice:a')!;
    expect(a).toMatchObject({ name: 'A', defaultHotkey: 'Mod+Shift+D', slash: 'roll', args: '[n]', source: 'ダイス', icon: 'puzzle' });
    expect(a.suggestArgs?.('')).toEqual([{ value: '1' }]);
    await a.run({ args: '  2 ', threadId: 't1', via: 'slash' });
    expect(run).toHaveBeenCalledWith({ args: '2', threadId: 't1', via: 'slash' });

    const b = f.commands.get('dice:b')!;
    expect(b.defaultHotkey).toBeUndefined();
    expect(b.slash).toBeUndefined();
    expect(b.icon).toBe('dice-5');
    expect(r.errors).toHaveLength(2);
    // 候補の例外は握りつぶす
    expect(f.commands.get('dice:c')!.suggestArgs?.('')).toEqual([]);
    r.stop();
    expect(f.commands.size).toBe(0);
  });

  it('外したあとの登録は無視し、register はすぐ片付ける', async () => {
    const f = fakeServices();
    let plugin: PluginBase | null = null;
    class P extends PluginBase {
      onload() {
        plugin = this;
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    r.stop();
    const late = vi.fn();
    plugin!.register(late);
    plugin!.addSlashCommand({ name: 'late', description: '', run: () => {} });
    expect(late).toHaveBeenCalledOnce();
    expect(f.slash.size).toBe(0);
  });

  it('loadData / saveData は JSON で端末に保存する', async () => {
    const f = fakeServices();
    let plugin: PluginBase | null = null;
    class P extends PluginBase {
      onload() {
        plugin = this;
      }
    }
    await new PluginRuntime(manifest, f.services).start(P as PluginClass);
    expect(await plugin!.loadData()).toBeNull();
    await plugin!.saveData({ a: 1 });
    expect(await plugin!.loadData()).toEqual({ a: 1 });
    expect(f.store.get('disnans.plugin.dice.data')).toBe('{"a":1}');
  });

  it('カードのメッセージが消えたら、そのセッションの view を閉じてキャッシュを捨てる', async () => {
    const f = fakeServices();
    const onClose = vi.fn();
    class P extends PluginBase {
      onload() {
        this.registerView('dice', () => ({ onOpen: () => {}, onClose }));
      }
    }
    const r = new PluginRuntime(manifest, f.services);
    await r.start(P as PluginClass);
    await r.mountView('dice', 's1', document.createElement('div'));
    expect(r.dropSessionsByMessage('other')).toEqual([]);
    expect(r.dropSessionsByMessage('m1')).toEqual(['s1']);
    expect(onClose).toHaveBeenCalledOnce();
    expect(r.sessions.peek('s1')).toBeUndefined();
  });
});

describe('Session', () => {
  async function setup() {
    const f = fakeServices();
    const r = new PluginRuntime(manifest, f.services);
    class P extends PluginBase {}
    await r.start(P as PluginClass);
    return { f, r };
  }

  it('同じ id なら同じオブジェクト', async () => {
    const { r, f } = await setup();
    const [a, b] = await Promise.all([r.sessions.get('s1'), r.sessions.get('s1')]);
    expect(a).toBe(b);
    expect(await r.sessions.get('s1')).toBe(a);
    expect(f.services.api.getSession).toHaveBeenCalledOnce();
  });

  it('update が成功すると反映して onChange を1回だけ呼ぶ（続く session.updated では呼ばない）', async () => {
    const { r, f } = await setup();
    const s = await r.sessions.get<{ n: number }>('s1');
    const cb = vi.fn();
    s.onChange(cb);
    await s.update({ n: 1 }, { card: { title: 'ダイス', text: '振った' } });
    expect(s.state).toEqual({ n: 1 });
    expect(s.version).toBe(2);
    expect(cb).toHaveBeenCalledOnce();
    r.sessions.applyUpdate(f.server);
    expect(cb).toHaveBeenCalledOnce();
    // 他の人の更新
    r.sessions.applyUpdate({ ...f.server, version: 3, state: { n: 5 } });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(s.state).toEqual({ n: 5 });
  });

  it('ぶつかったら最新を読み直してから VersionConflictError を投げる', async () => {
    const { r, f } = await setup();
    const s = await r.sessions.get<{ n: number }>('s1');
    // 他の人が先に更新した
    f.server = { ...f.server, version: 2, state: { n: 9 } };
    const cb = vi.fn();
    s.onChange(cb);
    await expect(s.update({ n: 1 })).rejects.toBeInstanceOf(VersionConflictError);
    expect(s.state).toEqual({ n: 9 });
    expect(s.version).toBe(2);
    expect(cb).toHaveBeenCalledOnce();
    // 最新の version で再試行すると通る
    await s.update({ n: 10 });
    expect(s.version).toBe(3);
  });

  it('emit は session.emit を送り、on は session.event を受け取る', async () => {
    const { r, f } = await setup();
    const s = await r.sessions.get('s1');
    s.emit('thinking', { on: true });
    expect(f.sent).toEqual([{ type: 'session.emit', session_id: 's1', name: 'thinking', payload: { on: true } }]);
    const cb = vi.fn();
    const off = s.on('thinking', cb);
    r.sessions.dispatchEvent('s1', 'thinking', 1, 'u2');
    r.sessions.dispatchEvent('s1', 'other', 2, 'u2');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toBe(1);
    expect(cb.mock.calls[0][1].display_name).toBe('B');
    off();
    r.sessions.dispatchEvent('s1', 'thinking', 3, 'u2');
    expect(cb).toHaveBeenCalledOnce();
  });

  it('プラグインを外すと購読は捨てる', async () => {
    const { r } = await setup();
    const s = await r.sessions.get('s1');
    const cb = vi.fn();
    s.onChange(cb);
    s.on('x', cb);
    r.stop();
    r.sessions.applyUpdate({ ...sessionData(), version: 5 });
    r.sessions.dispatchEvent('s1', 'x', null, 'u2');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('hotkey', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('Mod+Shift+D を読む（Mod は Ctrl、macOS では Cmd）', () => {
    expect(parseHotkey('Mod+Shift+D', false)).toEqual({ ctrl: true, meta: false, shift: true, alt: false, key: 'd' });
    expect(parseHotkey('Mod+Shift+D', true)).toEqual({ ctrl: false, meta: true, shift: true, alt: false, key: 'd' });
    expect(parseHotkey('Shift+', false)).toBeNull();
    expect(parseHotkey('Foo+D', false)).toBeNull();
  });

  it('修飾キーがすべて合うときだけ一致する', () => {
    const hk = parseHotkey('Mod+Shift+D', false)!;
    expect(matchHotkey(hk, key({ key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchHotkey(hk, key({ key: 'D', code: 'KeyD', ctrlKey: true }))).toBe(false);
    expect(matchHotkey(hk, key({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });
});

describe('parseManifest', () => {
  it('省略できる項目を補う', () => {
    expect(parseManifest('{"id":"dice","name":"ダイス","version":"1.0.0"}')).toEqual({
      id: 'dice',
      name: 'ダイス',
      version: '1.0.0',
      description: '',
      author: '',
      minApiVersion: 1,
    });
  });

  it('読めないものはエラー', () => {
    expect(() => parseManifest('{')).toThrow();
    expect(() => parseManifest('{"id":"Dice","name":"a","version":"1"}')).toThrow();
    expect(() => parseManifest('{"id":"dice","version":"1"}')).toThrow();
    // icon は Lucide のアイコン名（任意）
    expect(parseManifest('{"id":"dice","name":"a","version":"1","icon":"dice-5"}').icon).toBe('dice-5');
    expect(() => parseManifest('{"id":"dice","name":"a","version":"1","icon":"<svg>"}')).toThrow();
  });
});
