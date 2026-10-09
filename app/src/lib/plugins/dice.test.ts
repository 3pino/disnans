// @vitest-environment jsdom
// examples/dice をそのまま読み込んで、ホスト API の契約どおりに動くか確かめる
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginBase, PluginRuntime, type ViewHeader } from './runtime';
import { VersionConflictError } from './sessions';
import { createUi, type UiDeps } from './ui';
import { registerIcon, setLucideForTest } from '../icons.svelte';
import { API_VERSION, type HostCommand, type HostComposerAction, type HostServices, type HostSlashCommand, type PluginClass } from './types';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { Session as SessionData } from '../protocol/Session';

type DiceState = { schema: number; spec: string; count: number; sides: number; roller: string; result: number[] | null };
type Card = { title: string; text: string };

// main.js は一度だけ読み込まれ、そのときの disnans.ui を覚える。テストごとに差し替えられるように、中継しておく
const uiDeps: UiDeps = { toast: () => {}, confirm: async () => true };
(globalThis as unknown as { disnans: Disnans.Host }).disnans = {
  apiVersion: API_VERSION,
  Plugin: PluginBase,
  ui: createUi({ toast: (...a) => uiDeps.toast(...a), confirm: (o) => uiDeps.confirm(o) }),
  VersionConflictError,
};

const users = [
  { id: 'u1', login_name: 'a', display_name: 'A', avatar_url: null },
  { id: 'u2', login_name: 'b', display_name: 'B', avatar_url: null },
];

const DATA_KEY = 'disnans.plugin.dice.data';

/** 本体の代わり。サーバーのセッションは1つだけ持つ */
function setup(opts: { me?: string; data?: unknown; server?: SessionData } = {}) {
  const me = users.find((u) => u.id === (opts.me ?? 'u1'))!;
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  uiDeps.toast = toast;
  uiDeps.confirm = confirm;

  const slash = new Map<string, HostSlashCommand>();
  const actions = new Map<string, HostComposerAction>();
  const commands = new Map<string, HostCommand>();
  const sent: ClientEvent[] = [];
  const storage = new Map<string, string>();
  if (opts.data !== undefined) storage.set(DATA_KEY, JSON.stringify(opts.data));
  const openPanel = vi.fn();
  /** 次の updateSession を 409 にする回数 */
  let conflicts = 0;
  const state = { server: opts.server ?? null };

  const api = {
    createSession: async (body: { plugin: string; state: unknown; card: Card }) => {
      state.server = {
        id: 's1',
        plugin: body.plugin,
        message_id: 'm1',
        created_by: me.id,
        state: body.state,
        version: 1,
        card: body.card,
        created_at: 0,
        updated_at: 0,
      };
      return state.server;
    },
    getSession: async () => state.server!,
    updateSession: vi.fn(async (_id: string, body: { version: number; state: unknown; card: Card | null }) => {
      if (conflicts > 0) {
        conflicts--;
        throw Object.assign(new Error('conflict'), { status: 409, code: 'version_conflict' });
      }
      const s = state.server!;
      state.server = { ...s, version: s.version + 1, state: body.state, card: body.card ?? s.card };
      return state.server;
    }),
    notify: async () => {},
  };

  const services = {
    app: {
      me,
      users,
      user: (id: string) => users.find((u) => u.id === id),
      nameOf: (id: string) => users.find((u) => u.id === id)?.display_name ?? '不明なユーザー',
      isMobile: false,
      theme: 'light',
    },
    api,
    send: (ev: ClientEvent) => sent.push(ev),
    registerSlashCommand: (def: HostSlashCommand) => {
      slash.set(def.name, def);
      return () => slash.delete(def.name);
    },
    registerComposerAction: (a: HostComposerAction) => {
      actions.set(a.id, a);
      return () => actions.delete(a.id);
    },
    // 本体の登録簿（lib/commands.svelte.ts）と同じく、slash があればスラッシュコマンドにもする
    registerCommand: (c: HostCommand) => {
      commands.set(c.id, c);
      if (c.slash) {
        slash.set(c.slash, {
          name: c.slash,
          description: c.description || c.name,
          args: c.args,
          suggestArgs: c.suggestArgs,
          icon: c.icon,
          source: c.source,
          run: ({ args, threadId }) => c.run({ args, threadId, via: 'slash' }),
        });
      }
      return () => {
        commands.delete(c.id);
        if (c.slash) slash.delete(c.slash);
      };
    },
    openPanel,
    closePanel: () => {},
    toast,
    storage: {
      get: (k: string) => storage.get(k) ?? null,
      set: (k: string, v: string | null) => (v === null ? storage.delete(k) : storage.set(k, v)),
    },
    pluginIcon: () => 'puzzle',
    registerIcon,
    changed: () => {},
  } as unknown as HostServices;

  const r = new PluginRuntime(
    { id: 'dice', name: 'ダイス', version: '1.2.0', description: '', author: '', minApiVersion: 2 },
    services,
  );
  return {
    r,
    slash,
    actions,
    commands,
    sent,
    storage,
    openPanel,
    toast,
    confirm,
    api,
    state,
    conflictNext: (n: number) => (conflicts = n),
    settings: () => JSON.parse(storage.get(DATA_KEY) ?? 'null') as Record<string, unknown> | null,
  };
}

async function start(env: ReturnType<typeof setup>) {
  const mod = (await import('../../../../examples/dice/main.js')) as { default: PluginClass };
  await env.r.start(mod.default);
}

const result = (s: SessionData | null) => (s!.state as DiceState).result;

beforeEach(() =>
  setLucideForTest(
    Object.fromEntries(
      ['Puzzle', 'Dices', 'Dice5', 'BookOpen', 'CircleHelp', 'Sparkles', 'RotateCcw', 'Hand', 'Settings', 'Keyboard', 'Command'].map((k) => [
        k,
        [['path', { d: 'M1 1' }]],
      ]),
    ) as never,
  ),
);
afterEach(() => setLucideForTest(null));

describe('examples/dice', () => {
  it('/dice でセッションを作って view を開き、振ると揺れてから state とカードが更新される', async () => {
    const env = setup();
    await start(env);
    const { r, slash } = env;
    expect(slash.get('dice')?.suggestArgs?.('2')).toEqual([{ value: '2d6', description: 'サイコロ2個' }]);
    expect(slash.get('dice')?.icon).toBe('dice-cube');
    expect(r.defaultViewType()).toBe('dice');

    // 読めない引数はトースト
    await slash.get('dice')!.run({ args: 'abc', threadId: null });
    expect(env.toast).toHaveBeenCalledWith(expect.stringContaining('読めません'), 'error');

    await slash.get('dice')!.run({ args: ' 2d6 ', threadId: null });
    expect(env.state.server!.card.text).toBe('A がサイコロ（2d6）を用意しました');
    expect(env.openPanel).toHaveBeenCalledWith('dice', 'dice', 's1');

    const el = document.createElement('div');
    const headers: ViewHeader[] = [];
    const handle = await r.mountView('dice', 's1', el, (h) => headers.push(h));
    expect(headers.at(-1)).toEqual({ title: 'ダイス（2d6）', icon: 'dice-cube' });
    expect(el.querySelectorAll('.dice-face-pending')).toHaveLength(2);
    expect(el.querySelector('.nav-bar')).not.toBeNull();
    const button = el.querySelector<HTMLButtonElement>('button.btn.primary')!;
    expect(button.textContent).toBe('振る');
    expect(button.querySelector('svg.icon')).not.toBeNull();

    button.click();
    // ほかの人に「振っています」を送り、自分の画面も揺らす
    await vi.waitFor(() => expect(env.sent).toContainEqual({ type: 'session.emit', session_id: 's1', name: 'shake', payload: null }));
    expect(el.querySelectorAll('.dice-face-shaking')).toHaveLength(2);
    expect(el.querySelector<HTMLButtonElement>('button.btn.primary')!.disabled).toBe(true);

    await vi.waitFor(() => expect(result(env.state.server)).toHaveLength(2), { timeout: 3000 });
    expect(env.state.server!.card.text).toMatch(/^🎲 A: 2d6 → \d+ \+ \d+ = \d+$/);
    await vi.waitFor(() => expect(el.querySelectorAll('.dice-face-reveal')).toHaveLength(2));
    expect(el.querySelectorAll('.dice-face-pending, .dice-face-shaking')).toHaveLength(0);
    expect(headers.at(-1)).toEqual({ title: 'ダイス（2d6）', icon: 'dices' });
    expect(handle.session.version).toBe(2);

    // タブを「使い方」に切り替える
    el.querySelectorAll<HTMLButtonElement>('.nav-bar-item')[1].click();
    expect(el.querySelector('.dice-help')).not.toBeNull();
    expect(el.textContent).toContain('Ctrl+Shift+D');

    // カードの見た目
    const cardEl = document.createElement('div');
    expect(r.renderCard(cardEl, { sessionId: 's1', ...env.state.server!.card })).toBe(true);
    expect(cardEl.querySelector('.dice-card-title')?.textContent).toBe('ダイス');
    expect(cardEl.querySelector('.dice-card-done')?.textContent).toBe(env.state.server!.card.text);

    r.stop();
    expect(slash.size).toBe(0);
    expect(handle.closed).toBe(true);
  });

  it('「＋」メニューとコマンド（ショートカット・パレット）を登録する', async () => {
    const env = setup({ data: { animate: false } });
    await start(env);
    const action = env.actions.get('plugin:dice:roll-2d6')!;
    expect(action.label).toBe('サイコロ（2d6）');
    expect(action.icon).toBe('dices');
    await action.run({ threadId: 't1' });
    expect((env.state.server!.state as DiceState).spec).toBe('2d6');

    // コマンド: プラグイン ID を前に付けた ID で、既定のショートカット・スラッシュコマンド・アイコンを持つ
    const roll = env.commands.get('dice:roll')!;
    expect(roll.name).toBe('サイコロを用意する');
    expect(roll.defaultHotkey).toBe('Mod+Shift+D');
    expect(roll.slash).toBe('dice');
    expect(roll.icon).toBe('dice-cube');
    expect(roll.source).toBe('ダイス');
    // ショートカット・パレットからは引数なし → 設定の既定のサイコロ。開いているスレッドに用意する
    await roll.run({ args: '', threadId: 't2', via: 'hotkey' });
    expect((env.state.server!.state as DiceState).spec).toBe('1d6');
    expect(env.openPanel).toHaveBeenLastCalledWith('dice', 'dice', 's1');

    // パレットだけのコマンド
    const d20 = env.commands.get('dice:roll-d20')!;
    expect(d20.defaultHotkey).toBeUndefined();
    expect(d20.slash).toBeUndefined();
    expect(d20.icon).toBe('dice-5');
    await d20.run({ args: '', threadId: null, via: 'palette' });
    expect((env.state.server!.state as DiceState).spec).toBe('1d20');

    env.r.stop();
    expect(env.actions.size).toBe(0);
    expect(env.commands.size).toBe(0);
  });

  it('設定タブ: 既定のサイコロ・トグルを保存し、確認してから初期値に戻す', async () => {
    const env = setup();
    await start(env);
    expect(env.r.settingTabs).toHaveLength(1);
    const el = document.createElement('div');
    env.r.settingTabs[0].display(el);
    expect(el.querySelectorAll('.setting-row')).toHaveLength(4);
    expect(el.querySelector('hr.divider')).not.toBeNull();

    // 既定のサイコロ（segmented）→ /dice だけで送るとそれになる
    const option = [...el.querySelectorAll<HTMLButtonElement>('.segmented-option')].find((b) => b.textContent === '1d20')!;
    option.click();
    await vi.waitFor(() => expect(env.settings()).toMatchObject({ defaultSpec: '1d20' }));
    await env.slash.get('dice')!.run({ args: '', threadId: null });
    expect((env.state.server!.state as DiceState).spec).toBe('1d20');

    // トグル
    const toggles = el.querySelectorAll<HTMLButtonElement>('.toggle');
    toggles[0].click(); // 振る前に確認する
    toggles[1].click(); // 出目の演出
    await vi.waitFor(() => expect(env.settings()).toMatchObject({ confirmBeforeRoll: true, animate: false }));

    // 初期値に戻す: 断ったら何もしない
    env.confirm.mockResolvedValueOnce(false);
    el.querySelector<HTMLButtonElement>('button.btn.danger')!.click();
    await vi.waitFor(() => expect(env.confirm).toHaveBeenCalledTimes(1));
    expect(env.settings()).toMatchObject({ defaultSpec: '1d20' });

    el.querySelector<HTMLButtonElement>('button.btn.danger')!.click();
    await vi.waitFor(() => expect(env.settings()).toEqual({ defaultSpec: '1d6', confirmBeforeRoll: false, animate: true }));
    expect(env.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true }));
    // 描き直されている
    expect(el.querySelector('.segmented-option-selected')?.textContent).toBe('1d6');
    expect(el.querySelectorAll('.toggle-on')).toHaveLength(1);
    env.r.stop();
  });

  it('壊れた設定は初期値で読む', async () => {
    const env = setup({ data: { defaultSpec: 'abc', confirmBeforeRoll: 'yes', animate: false } });
    await start(env);
    await env.slash.get('dice')!.run({ args: '', threadId: null });
    expect((env.state.server!.state as DiceState).spec).toBe('1d6');
    env.r.stop();
  });

  it('「振る前に確認する」がオンなら確認し、断ると振らない。ぶつかったらやり直す', async () => {
    const env = setup({ data: { confirmBeforeRoll: true, animate: false } });
    await start(env);
    await env.slash.get('dice')!.run({ args: '1d6', threadId: null });
    const el = document.createElement('div');
    await env.r.mountView('dice', 's1', el);

    env.confirm.mockResolvedValueOnce(false);
    el.querySelector<HTMLButtonElement>('button.btn.primary')!.click();
    await vi.waitFor(() => expect(env.confirm).toHaveBeenCalledTimes(1));
    expect(env.api.updateSession).not.toHaveBeenCalled();
    expect(env.sent).toHaveLength(0);

    // 1回目は 409 → 最新を読み直してやり直す
    env.conflictNext(1);
    el.querySelector<HTMLButtonElement>('button.btn.primary')!.click();
    await vi.waitFor(() => expect(result(env.state.server)).toHaveLength(1));
    expect(env.api.updateSession).toHaveBeenCalledTimes(2);
    expect(env.toast).not.toHaveBeenCalled();
    env.r.stop();
  });

  it('ほかの人: 振る人の「振っています」で揺れ、結果が来たら目が出る', async () => {
    const server: SessionData = {
      id: 's1',
      plugin: 'dice',
      message_id: 'm1',
      created_by: 'u1',
      state: { schema: 1, spec: '2d6', count: 2, sides: 6, roller: 'u1', result: null } satisfies DiceState,
      version: 1,
      card: { title: 'ダイス', text: 'A がサイコロ（2d6）を用意しました' },
      created_at: 0,
      updated_at: 0,
    };
    const env = setup({ me: 'u2', server });
    await start(env);
    const el = document.createElement('div');
    await env.r.mountView('dice', 's1', el);
    expect(el.querySelector('button.btn.primary')).toBeNull();
    expect(el.textContent).toContain('A が振るのを待っています');

    // 振る人以外のイベントは無視する
    env.r.sessions.dispatchEvent('s1', 'shake', null, 'u2');
    expect(el.querySelectorAll('.dice-face-shaking')).toHaveLength(0);

    env.r.sessions.dispatchEvent('s1', 'shake', null, 'u1');
    expect(el.querySelectorAll('.dice-face-shaking')).toHaveLength(2);
    expect(el.textContent).toContain('A が振っています…');

    env.r.sessions.applyUpdate({ ...server, version: 2, state: { ...(server.state as DiceState), result: [6, 1] } });
    expect(el.querySelectorAll('.dice-face-shaking')).toHaveLength(0);
    expect(el.querySelectorAll('.dice-face-reveal')).toHaveLength(2);
    expect(el.querySelector('.dice-face-max')?.textContent).toBe('6');
    expect(el.querySelector('.dice-face-min')?.textContent).toBe('1');
    expect(el.querySelector('.dice-total')?.textContent).toBe('合計 7');
    env.r.stop();
  });
});
