// @vitest-environment jsdom
// 全画面の plugin view（registerView の layout: 'full'、API 20）は、チャット・設定・通話の代わりに主の場所をぜんぶ使う。
// ナビバーは覆われず出たまま（狭い画面）。見出し（PluginPanel のヘッダー）は出さない。ほかの plugin view は従来どおりの枠。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('./ChatView.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./PluginPanel.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./TimelinePanel.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./SettingsView.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./PluginSettingsPage.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./ConnectionBanner.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./TopBarSlot.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./CommandPalette.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./CallView.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./ScreenShareOverlay.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
// ナビバーは印の要素で置く（描画の中身ではなく、出ているかどうかを見る）
vi.mock('./NavBar.svelte', async () => ({ default: (await import('../test-support/NavBarMarker.svelte')).default }));
vi.mock('../lib/commandHost.svelte', () => ({ commandHost: { start: () => {} } }));
vi.mock('../lib/call/instance.svelte', () => ({ call: { joined: false, listed: false, state: null } }));
vi.mock('../lib/stores/client.svelte', () => ({ client: { user: () => null } }));

import Shell from './Shell.svelte';
import { ui } from '../lib/stores/ui.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  ui.tab = 'chat';
  ui.panel = null;
  ui.pluginBack = [];
  ui.isMobile = true;
  target = document.createElement('div');
  document.body.append(target);
  instance = mount(Shell, { target });
  flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined;
  target.remove();
  ui.isMobile = false;
  ui.panel = null;
});

const FULL = { plugin: 'files', view: 'browse', sessionId: null } as const;
const wrapper = () => target.querySelector<HTMLElement>('.shell-panel');
const fullWrapper = () => target.querySelector<HTMLElement>('.shell-panel.shell-panel-full');
const navShown = () => target.querySelector('[data-nav-marker]') !== null;
const mainChat = () => target.querySelector<HTMLElement>('#main-chat');

describe('全画面の plugin view（layout: full）', () => {
  it('狭い画面: 開くと全画面の枠（shell-panel-full）になり、ナビバーは出たまま、チャットは出さない', () => {
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    expect(ui.panel).toEqual({ kind: 'plugin', plugin: 'files', view: 'browse', sessionId: null, full: true });
    expect(fullWrapper()).not.toBeNull();
    expect(navShown()).toBe(true);
    expect(mainChat()?.classList.contains('shell-away')).toBe(true);
  });

  it('広い画面（デスクトップ）でも同じ（ナビバーは左に残る）', () => {
    ui.isMobile = false;
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    expect(fullWrapper()).not.toBeNull();
    expect(navShown()).toBe(true);
  });

  it('開いている間に設定を押すと、設定に移る（全画面の view は閉じる）', () => {
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    ui.openSettings();
    flushSync();
    expect(ui.tab).toBe('settings');
    expect(ui.panel).toBeNull();
    expect(fullWrapper()).toBeNull();
  });

  it('開いている間に通話を押すと、通話に移る（全画面の view は閉じる）', () => {
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    ui.openCall('reset');
    flushSync();
    expect(ui.tab).toBe('call');
    expect(ui.panel).toBeNull();
  });

  it('開いている間にチャットへ戻ると、全画面の view は閉じてチャットが出る', () => {
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    ui.showMain('always');
    flushSync();
    expect(ui.panel).toBeNull();
    expect(fullWrapper()).toBeNull();
    expect(mainChat()?.classList.contains('shell-away')).toBe(false);
  });

  it('全画面の view は、戻る操作で前の画面（チャット）に戻る', () => {
    ui.openPluginView('other', 'x', null);
    ui.openPluginView(FULL.plugin, FULL.view, null, true);
    flushSync();
    ui.back();
    flushSync();
    expect(ui.panel).toMatchObject({ kind: 'plugin', plugin: 'other', view: 'x' });
    expect(fullWrapper()).toBeNull();
  });
});

describe('ほかの plugin view（layout 省略）は、従来どおり', () => {
  it('全画面の枠（shell-panel のみ）で、狭い画面ではナビバーを出さない', () => {
    ui.openPluginView('dice', 'roll', null);
    flushSync();
    expect(wrapper()).not.toBeNull();
    expect(fullWrapper()).toBeNull();
    expect(navShown()).toBe(false);
  });

  it('同じ view 名でも layout が full でなければ、枠は従来どおり', () => {
    ui.openPluginView(FULL.plugin, FULL.view, null, false);
    flushSync();
    expect(fullWrapper()).toBeNull();
    expect(navShown()).toBe(false);
  });
});
