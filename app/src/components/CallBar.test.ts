// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { ScreenShareView } from '../lib/call/screen/view';
import { fakeScreen, sharer } from './testing/screenFake';

const { call, openCall, openSettingsSub } = vi.hoisted(() => ({
  call: {
    joined: true, pending: false, joining: false, deafened: false, participants: [],
    topBarButtons: [], barButtons: [], panels: [], outputs: [], screen: null as ScreenShareView | null,
    toggleDeafen: vi.fn(), leave: vi.fn(), refreshOutputs: vi.fn(async () => {}),
  },
  openCall: vi.fn(), openSettingsSub: vi.fn(),
}));
vi.mock('../lib/call/instance.svelte', () => ({ call }));
vi.mock('../lib/stores/ui.svelte', () => ({ ui: { openCall, openSettingsSub } }));
vi.mock('../lib/stores/client.svelte', () => ({ client: { user: (id: string) => ({ id, display_name: '共有者' }) } }));

import CallBar from './CallBar.svelte';
import CallView from './CallView.svelte';

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
beforeEach(() => {
  call.screen = fakeScreen({ sharers: [sharer('other')] });
  target = document.createElement('div'); document.body.append(target);
  vi.clearAllMocks();
});
afterEach(async () => { if (instance) await unmount(instance); instance = undefined; target.remove(); });

describe('最上部の通話バーの操作は増やさない', () => {
  it('画面・カメラ共有や閲覧の入口を追加せず、従来の通話操作だけを出す', () => {
    instance = mount(CallBar, { target }); flushSync();
    const labels = [...target.querySelectorAll<HTMLButtonElement>('.call-controls button')].map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['通話を全画面で開く', 'スピーカーミュート', '通話の設定', '通話から抜ける']);
    expect(target.querySelector('.screen-share-controls')).toBeNull();
    target.querySelector<HTMLButtonElement>('button[aria-label="通話を全画面で開く"]')!.click();
    expect(openCall).toHaveBeenCalledOnce();
  });

  it('共有の操作は通話画面内に残す', () => {
    instance = mount(CallView, { target }); flushSync();
    expect(target.querySelector('button[aria-label="画面を共有"]')).not.toBeNull();
    expect(target.querySelector('button[aria-label="カメラを共有"]')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('button[aria-label="画面を共有"]')!.click();
    expect(call.screen!.toggleScreen).toHaveBeenCalledOnce();
  });
});
