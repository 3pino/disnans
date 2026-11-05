// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ScreenShareStore } from '../lib/call/screen/store.svelte';
import type { ScreenCallPort } from '../lib/call/screen/types';
import { state } from './testing/screenShellState.svelte';

vi.mock('../lib/call/instance.svelte', async () => ({ call: (await import('./testing/screenShellState.svelte')).call }));
vi.mock('../lib/commandHost.svelte', async () => ({ commandHost: (await import('./testing/screenShellState.svelte')).commands }));
vi.mock('../lib/stores/client.svelte', () => ({ client: { user: (id: string) => ({ id, display_name: '配信者' }) } }));
// 音声・メディアの取得・ネットワーク・他のタブは試験しない。Shell、CallView、Preview、Overlay、Viewer は実物。
vi.mock('./ChatView.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./PluginPanel.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./TimelinePanel.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./SettingsView.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./FileExplorer.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./PluginSettingsPage.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./ConnectionBanner.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./NavBar.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./TopBarSlot.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));
vi.mock('./CommandPalette.svelte', async () => ({ default: (await import('./testing/ChatChildStub.svelte')).default }));

import Shell from './Shell.svelte';
import { ui } from '../lib/stores/ui.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
let screen: ScreenShareStore;
beforeEach(() => {
  state.paletteOpen = false;
  ui.tab = 'call'; ui.panel = null; ui.pluginBack = [];
  const call: ScreenCallPort = { joined: true, listed: true, myPeer: 'self', bufferedAmount: 0,
    participants: [{ peer: 'remote', userId: 'remote-user', self: false }], emit: vi.fn() };
  screen = new ScreenShareStore({ call,
    capture: { supported: false, start: vi.fn(), stop: vi.fn(), update: vi.fn(), snapshot: vi.fn() },
    settings: { value: { fps: 5, quality: 'p720', color: 'full' }, patch: vi.fn(), subscribe: () => () => {} }, toast: vi.fn() });
  screen.onEvent('screen.state', { peer: 'remote', userId: 'remote-user', payload: { on: true } });
  screen.onEvent('screen.frame', { peer: 'remote', userId: 'remote-user', payload: { f: 1, i: 0, n: 1, d: '/9j/QUJD' } });
  state.screen = screen;
  target = document.createElement('div'); document.body.append(target);
  instance = mount(Shell, { target }); flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  instance = undefined; target.remove(); screen.dispose(); state.screen = null; state.paletteOpen = false;
  ui.tab = 'chat'; ui.panel = null; ui.pluginBack = [];
});

function openFromCallView(): HTMLElement {
  const button = target.querySelector<HTMLButtonElement>('.call-view-streams .screen-stage[aria-label="配信者の画面を全画面で見る"]');
  expect(button).not.toBeNull(); button!.click(); flushSync();
  const dialog = target.querySelector<HTMLElement>('.screen-viewer[role="dialog"]');
  expect(dialog).not.toBeNull(); return dialog!;
}

describe('Shell の通常操作から共有映像を全画面の閲覧へ開く', () => {
  it('コマンドパレットを閉じたまま、実際の共有状態とボタンから全画面を開ける', () => {
    expect(state.paletteOpen).toBe(false);
    const dialog = openFromCallView();
    expect(screen.viewerOpen).toBe(true);
    expect(target.querySelectorAll('.screen-viewer')).toHaveLength(1);
    expect(dialog.querySelector<HTMLImageElement>('.image-viewer-image')!.src).toContain('/9j/QUJD');
  });
  it('パレットの開閉で二重表示や取り外しをせず、一つの閲覧画面を維持する', () => {
    const dialog = openFromCallView();
    state.paletteOpen = true; flushSync();
    expect(target.querySelectorAll('.screen-viewer')).toHaveLength(1);
    expect(target.querySelector('.screen-viewer')).toBe(dialog);
    state.paletteOpen = false; flushSync();
    expect(target.querySelector('.screen-viewer')).toBe(dialog);
  });
  it('通話タブから離れても閲覧は残り、閉じるボタンで実際の状態を閉じる', () => {
    const dialog = openFromCallView();
    ui.tab = 'chat'; flushSync();
    expect(target.querySelector('.screen-viewer')).toBe(dialog);
    dialog.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!.click(); flushSync();
    expect(screen.viewerOpen).toBe(false);
    expect(target.querySelector('.screen-viewer')).toBeNull();
  });
});
