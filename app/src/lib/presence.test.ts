// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { sameViewers, uniqueViewers } from './presence';
import { SessionsImpl } from './plugins/sessions';
import { PluginRuntime, PluginBase } from './plugins/runtime';
import type { HostServices, Manifest, PluginClass } from './plugins/types';
import type { Session as SessionData } from './protocol/Session';
import { presence } from './stores/presence.svelte';

const data = (over: Partial<SessionData> = {}): SessionData => ({
  id: 's1',
  plugin: 'dice',
  message_id: 'm1',
  created_by: 'u1',
  state: {},
  version: 1,
  card: { title: 't', text: 'x' },
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe('presence の部品', () => {
  it('uniqueViewers は重複と空を除く（順序は保つ）', () => {
    expect(uniqueViewers(['b', 'a', 'b', '', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('sameViewers は順序も見る', () => {
    expect(sameViewers(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameViewers(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameViewers([], ['a'])).toBe(false);
  });
});

describe('プラグインの session.viewers / onViewers', () => {
  it('applyPresence で値が変わったときだけ onViewers が呼ばれる', async () => {
    const api = { getSession: vi.fn(async () => data()) };
    const services = { api, app: { user: () => undefined } } as unknown as HostServices;
    const sessions = new SessionsImpl('dice', services);
    const s = await sessions.get('s1');
    const cb = vi.fn();
    s.onViewers(cb);
    expect(s.viewers).toEqual([]);
    sessions.applyPresence('s1', ['u1', 'u2', 'u1']);
    expect(s.viewers).toEqual(['u1', 'u2']);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(['u1', 'u2']);
    sessions.applyPresence('s1', ['u1', 'u2']);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('読み込んでいないセッションの presence は持たない', () => {
    const services = { api: {}, app: {} } as unknown as HostServices;
    const sessions = new SessionsImpl('dice', services);
    expect(() => sessions.applyPresence('nope', ['u1'])).not.toThrow();
  });

  it('外したあとは onViewers が呼ばれない', async () => {
    const services = { api: { getSession: vi.fn(async () => data()) }, app: {} } as unknown as HostServices;
    const sessions = new SessionsImpl('dice', services);
    const s = await sessions.get('s1');
    const cb = vi.fn();
    s.onViewers(cb);
    sessions.dispose();
    sessions.applyPresence('s1', ['u1']);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('view を開いた・閉じた（プレゼンスの open / close）', () => {
  const manifest: Manifest = { id: 'dice', name: 'ダイス', version: '1', description: '', author: '', minApiVersion: 14 };

  function setup() {
    const presenceCalls: [string, boolean][] = [];
    const services = {
      api: { getSession: vi.fn(async () => data()) },
      app: {},
      presence: (id: string, open: boolean) => void presenceCalls.push([id, open]),
      closePanel: vi.fn(),
      changed: vi.fn(),
    } as unknown as HostServices;
    const r = new PluginRuntime(manifest, services);
    class P extends PluginBase {}
    return { r, presenceCalls, start: () => r.start(P as PluginClass) };
  }

  it('開いたら open、閉じたら close を一度ずつ送る（同じセッションを二重に開いても）', async () => {
    const { r, presenceCalls, start } = setup();
    await start();
    r.registerView('dice', () => ({ onOpen() {} }) as unknown as Disnans.View);
    const el = document.createElement('div');
    const h1 = await r.mountView('dice', 's1', el);
    const h2 = await r.mountView('dice', 's1', document.createElement('div'));
    expect(presenceCalls).toEqual([['s1', true]]);
    h1.close();
    expect(presenceCalls).toEqual([['s1', true]]);
    h2.close();
    expect(presenceCalls).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('閉じたあとの close は数えない', async () => {
    const { r, presenceCalls, start } = setup();
    await start();
    r.registerView('dice', () => ({ onOpen() {} }) as unknown as Disnans.View);
    const h = await r.mountView('dice', 's1', document.createElement('div'));
    h.close();
    h.close();
    expect(presenceCalls).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('onOpen が失敗したら open は送らない', async () => {
    const { r, presenceCalls, start } = setup();
    await start();
    r.registerView('dice', () => ({ onOpen() { throw new Error('x'); } }) as unknown as Disnans.View);
    await expect(r.mountView('dice', 's1', document.createElement('div'))).rejects.toThrow('x');
    expect(presenceCalls).toEqual([]);
  });

  it('外したときは、開いていたものを close で閉じる', async () => {
    const { r, presenceCalls, start } = setup();
    await start();
    r.registerView('dice', () => ({ onOpen() {} }) as unknown as Disnans.View);
    await r.mountView('dice', 's1', document.createElement('div'));
    r.stop();
    expect(presenceCalls).toEqual([
      ['s1', true],
      ['s1', false],
    ]);
  });

  it('接続し直したら、開いているものを open し直す', async () => {
    const { r, presenceCalls, start } = setup();
    await start();
    r.registerView('dice', () => ({ onOpen() {} }) as unknown as Disnans.View);
    await r.mountView('dice', 's1', document.createElement('div'));
    r.resendPresence();
    expect(presenceCalls).toEqual([
      ['s1', true],
      ['s1', true],
    ]);
  });
});

describe('本体の表示用の presence（stores/presence）', () => {
  it('apply で一覧を持ち、空になれば消す', () => {
    presence.apply('p1', ['u1', 'u1', 'u2']);
    expect(presence.viewers('p1')).toEqual(['u1', 'u2']);
    presence.apply('p1', []);
    expect(presence.viewers('p1')).toEqual([]);
  });
});
