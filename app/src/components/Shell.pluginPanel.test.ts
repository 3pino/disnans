// @vitest-environment jsdom
// 回帰: コアの「ファイル」（fixplor の view）を開いたとき、パネルは全画面の .shell-panel にならず、
// ナビバーは覆われず出たまま（狭い画面）。ほかのプラグインの view は、従来どおり全画面の枠（ナビバーは隠れる）。
// 古い Shell（class:shell-panel-files の付け方がない）では、最初の検査が落ちる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('./ChatView.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./PluginPanel.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./TimelinePanel.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./SettingsView.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./FileExplorer.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./PluginSettingsPage.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./ConnectionBanner.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./TopBarSlot.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./CommandPalette.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
vi.mock('./ScreenShareOverlay.svelte', async () => ({ default: (await import('../test-support/ChatChildStub.svelte')).default }));
// ナビバーは印の要素で置く（描画の中身ではなく、出ているかどうかを見る）
vi.mock('./NavBar.svelte', async () => ({ default: (await import('../test-support/NavBarMarker.svelte')).default }));
vi.mock('../lib/commandHost.svelte', () => ({ commandHost: { start: () => {} } }));
vi.mock('../lib/call/instance.svelte', () => ({ call: { joined: false, listed: false, state: null } }));
vi.mock('../lib/stores/client.svelte', () => ({ client: { user: () => null } }));

import Shell from './Shell.svelte';
import { ui } from '../lib/stores/ui.svelte';
import { coreFiles } from '../lib/coreFiles.svelte';
import { CORE_FILES_PLUGIN, CORE_FILES_VIEW } from '../lib/plugins/core';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  ui.tab = 'chat';
  ui.panel = null;
  ui.pluginBack = [];
  ui.isMobile = true;
  coreFiles.active = true;
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
  coreFiles.active = false;
  ui.panel = null;
});

const wrapper = () => target.querySelector<HTMLElement>('.shell-panel');
const navShown = () => target.querySelector('[data-nav-marker]') !== null;

describe('コアの「ファイル」（plugin view）は、全画面の枠にならない', () => {
  it('狭い画面: コアの view は shell-panel-files を付け、ナビバーは出たまま', () => {
    ui.panel = { kind: 'plugin', plugin: CORE_FILES_PLUGIN, view: CORE_FILES_VIEW, sessionId: null };
    flushSync();
    expect(wrapper()).not.toBeNull();
    expect(wrapper()!.classList.contains('shell-panel-files')).toBe(true);
    expect(navShown()).toBe(true);
  });

  it('広い画面（デスクトップ）でも、コアの view は shell-panel-files を付ける（ナビバーは左に残る）', () => {
    ui.isMobile = false;
    ui.panel = { kind: 'plugin', plugin: CORE_FILES_PLUGIN, view: CORE_FILES_VIEW, sessionId: null };
    flushSync();
    expect(wrapper()!.classList.contains('shell-panel-files')).toBe(true);
    expect(navShown()).toBe(true);
  });

  it('ほかのプラグインの view は、従来どおり全画面の枠（shell-panel のみ）で、狭い画面ではナビバーを出さない', () => {
    ui.panel = { kind: 'plugin', plugin: 'dice', view: 'roll', sessionId: null };
    flushSync();
    expect(wrapper()).not.toBeNull();
    expect(wrapper()!.classList.contains('shell-panel-files')).toBe(false);
    expect(navShown()).toBe(false);
  });

  it('コアの「ファイル」の view でも、同じ名前のほかのプラグインは全画面のまま（ID で判定）', () => {
    ui.panel = { kind: 'plugin', plugin: 'other', view: CORE_FILES_VIEW, sessionId: null };
    flushSync();
    expect(wrapper()!.classList.contains('shell-panel-files')).toBe(false);
    expect(navShown()).toBe(false);
  });

  it('コアが読めていない（フォールバック）でも、内蔵の「ファイル」は従来どおり出る', () => {
    coreFiles.active = false;
    ui.panel = { kind: 'files' };
    flushSync();
    expect(target.querySelector('.shell-panel-files')).not.toBeNull();
    expect(navShown()).toBe(true);
  });
});
