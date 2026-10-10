// @vitest-environment jsdom
// addMessageAction / openTimeline と、examples/messages（あとで読む）
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { createUi } from './ui';
import { API_VERSION, type HostCommand, type HostMessageAction, type HostServices, type HostTimelineSpec, type PluginClass } from './types';
import { VersionConflictError } from './sessions';
import type { Message } from '../protocol/Message';

const toast = vi.fn();
(globalThis as unknown as { disnans: Partial<Disnans.Host> }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: (...a) => toast(...a), confirm: async () => true }),
  VersionConflictError,
};

function m(id: string, over: Partial<Message> = {}): Message {
  return { id, body: id, card: null, ...over } as unknown as Message;
}

function setup(known: Message[]) {
  const actions: HostMessageAction[] = [];
  const commands = new Map<string, HostCommand>();
  const timelines: { spec: HostTimelineSpec; update: ReturnType<typeof vi.fn>; closed: boolean }[] = [];
  const store = new Map<string, string>();
  const services = {
    app: { me: { id: 'u1' }, users: [], user: () => undefined, nameOf: () => '', isMobile: false, theme: 'light' },
    api: {},
    registerSlashCommand: () => () => {},
    registerComposerAction: () => () => {},
    registerCommand: (c: HostCommand) => {
      commands.set(c.id, c);
      return () => {};
    },
    registerMessageAction: (a: HostMessageAction) => {
      actions.push(a);
      return () => {
        actions.splice(actions.indexOf(a), 1);
      };
    },
    findMessage: (id: string) => known.find((x) => x.id === id),
    openTimeline: (spec: HostTimelineSpec) => {
      const t = { spec, update: vi.fn(), closed: false };
      timelines.push(t);
      return {
        update: (patch: Parameters<ReturnType<HostServices['openTimeline']>['update']>[0]) => {
          t.update(patch);
          t.spec = { ...t.spec, ...patch };
        },
        close: () => {
          if (t.closed) return;
          t.closed = true;
          t.spec.onClose?.();
        },
      };
    },
    closePanel: () => {},
    toast: vi.fn(),
    storage: { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string | null) => void (v === null ? store.delete(k) : store.set(k, v)) },
    pluginIcon: () => 'puzzle',
    registerIcon: () => () => {},
    changed: () => {},
  } as unknown as HostServices;
  const r = new PluginRuntime({ id: 'read-later', name: 'あとで読む', version: '0.1.0', description: '', author: '', minApiVersion: 9 }, services);
  return { r, actions, commands, timelines };
}

describe('addMessageAction', () => {
  it('ID に plugin: を付け、アイコン・placement の既定を補い、when / run に ctx を渡す', async () => {
    const { r, actions } = setup([]);
    const when = vi.fn(() => true);
    const run = vi.fn();
    class P extends PluginBase {
      onload() {
        this.addMessageAction({ id: 'x', label: 'X', when, run });
      }
    }
    await r.start(P as unknown as PluginClass);
    expect(actions).toHaveLength(1);
    const a = actions[0];
    expect(a.id).toBe('plugin:read-later:x');
    expect(a.placement).toBe('both');
    expect(a.icon).toBe('puzzle');
    const c = { message: m('m1'), inThread: true, place: 't1' };
    expect(a.when!(c)).toBe(true);
    expect(when).toHaveBeenCalledWith(c.message, { threadId: 't1', inThread: true });
    await a.run({ ...c, anchor: new DOMRect(), openPicker: () => {} });
    expect(run).toHaveBeenCalledWith(c.message, { threadId: 't1', inThread: true });
    r.stop();
    expect(actions).toHaveLength(0);
  });

  it('when が例外なら出さない。placement が不正なら登録せずエラーに残す', async () => {
    const { r, actions } = setup([]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    class P extends PluginBase {
      onload() {
        this.addMessageAction({
          id: 'bad',
          label: 'B',
          when: () => {
            throw new Error('x');
          },
          run() {},
        });
        this.addMessageAction({ id: 'worse', label: 'W', placement: 'nowhere' as 'menu', run() {} });
      }
    }
    await r.start(P as unknown as PluginClass);
    expect(actions).toHaveLength(1);
    expect(actions[0].when!({ message: m('m1'), inThread: false, place: null })).toBe(false);
    expect(r.errors).toHaveLength(1);
    err.mockRestore();
  });
});

describe('openTimeline', () => {
  it('messageIds は読み込み済みのものだけ解決し、depths を深さにする', async () => {
    const { r, timelines } = setup([m('a'), m('b')]);
    class P extends PluginBase {
      onload() {
        this.openTimeline({ title: 'T', messageIds: ['b', 'zzz', 'a'], depths: { a: 2 } });
      }
    }
    await r.start(P as unknown as PluginClass);
    expect(timelines[0].spec.title).toBe('T');
    expect(timelines[0].spec.entries().map((e) => [e.message.id, e.depth])).toEqual([
      ['b', 0],
      ['a', 2],
    ]);
  });

  it('messages は読み込み済みなら最新に差し替え、update で並びを替え、閉じると onClose', async () => {
    const live = m('a', { body: 'new' });
    const { r, timelines } = setup([live]);
    const onClose = vi.fn();
    let h!: Disnans.TimelineHandle;
    class P extends PluginBase {
      onload() {
        h = this.openTimeline({ title: 'T', messages: [m('a', { body: 'old' }), m('snap')], onClose });
      }
    }
    await r.start(P as unknown as PluginClass);
    const t = timelines[0];
    expect(t.spec.entries().map((e) => [e.message.id, e.message.body])).toEqual([
      ['a', 'new'],
      ['snap', 'snap'],
    ]);
    h.update({ title: 'U', messageIds: ['a'] });
    expect(t.spec.title).toBe('U');
    expect(t.spec.entries().map((e) => e.message.id)).toEqual(['a']);
    expect(() => h.update({ messages: [], messageIds: [] })).toThrow();
    h.close();
    h.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.closed).toBe(true);
  });

  it('messages と messageIds を両方渡すと例外。プラグインを外すと開いているパネルを閉じる', async () => {
    const { r, timelines } = setup([m('a')]);
    const onClose = vi.fn();
    class P extends PluginBase {
      onload() {
        expect(() => this.openTimeline({ title: 'T', messages: [], messageIds: [] })).toThrow();
        this.openTimeline({ title: 'T', messageIds: ['a'], onClose });
      }
    }
    await r.start(P as unknown as PluginClass);
    r.stop();
    expect(timelines[0].closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('examples/messages', () => {
  it('「あとで読む」で覚え、コマンドでタイムラインに並べ、開いたまま変えると並びも変わる', async () => {
    const { r, actions, commands, timelines } = setup([m('a'), m('b')]);
    const mod = (await import('../../../../examples/messages/main.js')) as { default: PluginClass };
    await r.start(mod.default);
    const act = actions[0];
    expect(act.when!({ message: m('c', { card: {} as never }), inThread: false, place: null })).toBe(false);
    const run = (id: string) => act.run({ message: m(id), inThread: false, place: null, anchor: new DOMRect(), openPicker: () => {} });
    await run('a');
    await run('b');
    commands.get('read-later:open')!.run({ args: '', threadId: null, via: 'palette' } as never);
    expect(timelines[0].spec.entries().map((e) => e.message.id)).toEqual(['b', 'a']);
    await run('b');
    expect(timelines[0].spec.entries().map((e) => e.message.id)).toEqual(['a']);
  });
});
