// @vitest-environment jsdom
// examples/dice をそのまま読み込んで、ホスト API の契約どおりに動くか確かめる
import { describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime } from './runtime';
import { VersionConflictError } from './sessions';
import { createUi } from './ui';
import { API_VERSION, type HostServices, type HostSlashCommand, type PluginClass } from './types';
import type { Session as SessionData } from '../protocol/Session';

describe('examples/dice', () => {
  it('/dice でセッションを作って view を開き、振ると state とカードが更新される', async () => {
    const toast = vi.fn();
    (globalThis as unknown as { disnans: Disnans.Host }).disnans = {
      apiVersion: API_VERSION,
      Plugin: PluginBase,
      ui: createUi({ toast, confirm: async () => true }),
      VersionConflictError,
    };

    const slash = new Map<string, HostSlashCommand>();
    let server: SessionData | null = null;
    const openPanel = vi.fn();
    const services = {
      app: {
        me: { id: 'u1', login_name: 'a', display_name: 'A', avatar_url: null },
        users: [],
        user: () => undefined,
        nameOf: (id: string) => (id === 'u1' ? 'A' : '不明なユーザー'),
        isMobile: false,
        theme: 'light',
      },
      api: {
        createSession: async (body: { plugin: string; state: unknown; card: { title: string; text: string } }) => {
          server = {
            id: 's1',
            plugin: body.plugin,
            message_id: 'm1',
            created_by: 'u1',
            state: body.state,
            version: 1,
            card: body.card,
            created_at: 0,
            updated_at: 0,
          };
          return server;
        },
        getSession: async () => server!,
        updateSession: async (_id: string, body: { version: number; state: unknown; card: { title: string; text: string } | null }) => {
          server = { ...server!, version: server!.version + 1, state: body.state, card: body.card ?? server!.card };
          return server;
        },
        notify: async () => {},
      },
      send: () => {},
      registerSlashCommand: (def: HostSlashCommand) => {
        slash.set(def.name, def);
        return () => slash.delete(def.name);
      },
      registerComposerAction: () => () => {},
      openPanel,
      closePanel: () => {},
      toast,
      storage: { get: () => null, set: () => {} },
      changed: () => {},
    } as unknown as HostServices;

    const mod = (await import('../../../../examples/dice/main.js')) as { default: PluginClass };
    const r = new PluginRuntime(
      { id: 'dice', name: 'ダイス', version: '1.0.0', description: '', author: '', minApiVersion: 1 },
      services,
    );
    await r.start(mod.default);
    expect(slash.get('dice')?.suggestArgs?.('2')).toEqual([{ value: '2d6', description: 'サイコロ2個' }]);
    expect(r.defaultViewType()).toBe('dice');

    // 読めない引数はトースト
    await slash.get('dice')!.run({ args: 'abc', threadId: null });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('読めません'), 'error');

    await slash.get('dice')!.run({ args: ' 2d6 ', threadId: null });
    expect(server!.card.text).toBe('A がサイコロ（2d6）を用意しました');
    expect(openPanel).toHaveBeenCalledWith('dice', 'dice', 's1');

    const el = document.createElement('div');
    const handle = await r.mountView('dice', 's1', el);
    expect(el.querySelectorAll('.dice-face-pending')).toHaveLength(2);
    const button = el.querySelector<HTMLButtonElement>('button.btn.primary')!;
    expect(button.textContent).toBe('振る');
    button.click();
    await vi.waitFor(() => expect((server!.state as { result: number[] | null }).result).toHaveLength(2));
    expect(server!.card.text).toMatch(/^🎲 A: 2d6 → \d+ \+ \d+ = \d+$/);
    await vi.waitFor(() => expect(el.querySelectorAll('.dice-face-pending')).toHaveLength(0));
    expect(handle.session.version).toBe(2);

    r.stop();
    expect(slash.size).toBe(0);
    expect(handle.closed).toBe(true);
  });
});
