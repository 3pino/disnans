// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TopBarSlot from './TopBarSlot.svelte';
import { ui } from '../lib/stores/ui.svelte';

// 通話のバーの有無だけを見る（中身は別のテスト）。通話の状態はテストで決める
const h = vi.hoisted(() => ({ visible: true }));
vi.mock('../lib/call/instance.svelte', () => ({
  call: {
    get visible() {
      return h.visible;
    },
  },
}));
// 通話のバーは、印の要素だけにする（描画は CallBar の仕事）
vi.mock('./CallBar.svelte', async () => ({ default: (await import('./testing/CallBarStub.svelte')).default }));
// プラグインのステータス欄も、印の要素だけにする（描画は PluginStatusBar の仕事）
vi.mock('./PluginStatusBar.svelte', async () => ({ default: (await import('./testing/PluginStatusBarStub.svelte')).default }));

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement | undefined;

beforeEach(() => {
  h.visible = true;
  target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(TopBarSlot, { target });
  flushSync();
});
afterEach(async () => {
  if (instance) await unmount(instance);
  target?.remove();
  instance = undefined;
  target = undefined;
  ui.tab = 'chat';
  ui.panel = null;
});

const callBarShown = () => document.querySelector('.top-slot .call-bar') !== null;
const pluginBarShown = () => document.querySelector('.top-slot .plugin-status-stub') !== null;

/** 画面の状態（タブとパネル）。エクスプローラーは、開いたときのタブを残す（ui.openFiles と同じ） */
type Screen = 'chat' | 'settings' | 'call' | 'files-over-chat' | 'files-over-call';
const SCREENS: Screen[] = ['chat', 'settings', 'call', 'files-over-chat', 'files-over-call'];
function show(s: Screen): void {
  ui.tab = s === 'settings' ? 'settings' : s === 'call' || s === 'files-over-call' ? 'call' : 'chat';
  ui.panel = s.startsWith('files') ? { kind: 'files' } : null;
  flushSync();
}

describe('上部の枠（通話のバー）は、画面が変わっても一貫する', () => {
  it('通話に参加中の、どの画面からどの画面へ移っても、通話の画面が見えるときだけ通話のバーを出さない', () => {
    for (const from of SCREENS) {
      for (const to of SCREENS) {
        show(from);
        show(to);
        const expected = to !== 'call';
        expect(callBarShown(), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('通話に参加していなければ、どの画面でも通話のバーは出さない', async () => {
    // 通話の状態は普通のオブジェクトなので、いったん外して付け直す
    await unmount(instance!);
    h.visible = false;
    instance = mount(TopBarSlot, { target: target! });
    flushSync();
    for (const s of SCREENS) {
      show(s);
      expect(callBarShown(), s).toBe(false);
    }
  });

  it('通話のタブからエクスプローラーを開くと、通話のバーが出る（通話の画面は隠れている）', () => {
    show('call');
    expect(callBarShown()).toBe(false);
    ui.openFiles();
    flushSync();
    expect(ui.tab).toBe('call');
    expect(callBarShown()).toBe(true);
  });
});

describe('プラグインのステータス欄も、通話の画面が見えているときは出さない（通話のバーと同じ規則）', () => {
  it('通話の画面（通話のタブで、エクスプローラーに隠れていない）では出さない。ほかの画面では出す', () => {
    for (const s of SCREENS) {
      show(s);
      expect(pluginBarShown(), s).toBe(s !== 'call');
    }
  });

  it('通話のタブからエクスプローラーを開くと、通話の画面は隠れるので出す', () => {
    show('call');
    expect(pluginBarShown()).toBe(false);
    ui.openFiles();
    flushSync();
    expect(pluginBarShown()).toBe(true);
  });

  it('通話に参加していなくても、通話の画面では出さない（規則は画面だけで決まる）', async () => {
    await unmount(instance!);
    h.visible = false;
    instance = mount(TopBarSlot, { target: target! });
    flushSync();
    show('call');
    expect(pluginBarShown()).toBe(false);
    show('chat');
    expect(pluginBarShown()).toBe(true);
  });
});
