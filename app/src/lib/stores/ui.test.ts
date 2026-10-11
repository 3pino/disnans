import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ui } from './ui.svelte';

/** チャットのトップ・履歴なしに戻す */
function reset(mobile = true) {
  ui.isMobile = mobile;
  ui.tab = 'chat';
  ui.panel = null;
  ui.settingsSub = null;
  ui.pluginSettings = null;
  ui.searchOpen = false;
  ui.lightbox = null;
  ui.pluginBack = [];
  ui.navStack = [];
}

beforeEach(() => reset());

describe('ui.back', () => {
  it('画像の全画面を最初に閉じ、次にプラグインの層、そのあと遷移の履歴を戻る', () => {
    ui.openThread('t1');
    ui.openSearch();
    ui.openThread('t1');
    const run = vi.fn();
    ui.addPluginBack(run);
    ui.lightbox = { src: 'x', alt: 'x.png', downloadUrl: 'x' };
    expect(ui.backDepth()).toBe(5);

    expect(ui.back()).toBe(true);
    expect(ui.lightbox).toBeNull();
    expect(ui.panel).not.toBeNull();
    expect(ui.back()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    // プラグインの層は呼んだときに外れる（プラグインが外し忘れても空回りしない）
    expect(ui.pluginBack).toHaveLength(0);
    expect(ui.back()).toBe(true);
    expect(ui.searchOpen).toBe(true);
    expect(ui.panel).toBeNull();
  });

  it('何も開いていなければ戻る先はない（Android ではアプリが裏に回る）', () => {
    expect(ui.backDepth()).toBe(0);
    expect(ui.back()).toBe(false);
  });

  it('返信のツリーは、戻るとチャットへ', () => {
    ui.openReplyTree('m1', null);
    expect(ui.panel).toEqual({ kind: 'replyTree', messageId: 'm1', place: null });
    expect(ui.backDepth()).toBe(1);
    ui.back();
    expect(ui.panel).toBeNull();
    expect(ui.tab).toBe('chat');
    expect(ui.backDepth()).toBe(0);
  });

  it('スレッドの中で開いた返信のツリーは、戻るとスレッドへ', () => {
    ui.openThread('t1');
    ui.openReplyTree('m1', 't1');
    ui.back();
    expect(ui.panel).toEqual({ kind: 'thread', id: 't1' });
  });

  it('通話の画面から開いた通話の設定は、戻ると通話の画面へ', () => {
    ui.openCall();
    ui.openSettingsSub('call');
    expect(ui.tab).toBe('settings');
    ui.back();
    expect(ui.tab).toBe('call');
    expect(ui.settingsSub).toBeNull();
    ui.back();
    expect(ui.tab).toBe('chat');
  });

  it('チャット（通話のバー）から開いた通話の設定は、戻るとチャットへ', () => {
    ui.openSettingsSub('call');
    ui.back();
    expect(ui.tab).toBe('chat');
    expect(ui.backDepth()).toBe(0);
  });

  it('設定の一覧から開いたサブページは、戻ると一覧へ', () => {
    ui.openSettings();
    ui.openSettingsSub('hotkeys');
    ui.back();
    expect(ui.tab).toBe('settings');
    expect(ui.settingsSub).toBeNull();
    ui.back();
    expect(ui.tab).toBe('chat');
  });
});

describe('ui.selectTab / openSettings（タブの切り替え）', () => {
  it('タブを切り替えると履歴を捨てる。チャット以外のタブで戻るとチャットのトップへ', () => {
    ui.openCall();
    ui.openSettingsSub('call');
    ui.selectTab('threads');
    expect(ui.navStack).toHaveLength(1);
    ui.openThread('t1');
    ui.back();
    expect(ui.tab).toBe('threads');
    ui.back();
    expect(ui.tab).toBe('chat');
    expect(ui.back()).toBe(false);
  });

  it('タブを何度切り替えても履歴は積み上がらない', () => {
    for (let i = 0; i < 10; i++) {
      ui.openSettings();
      ui.selectTab('threads');
      ui.openCall('reset');
    }
    expect(ui.backDepth()).toBe(1);
    ui.selectTab('chat');
    expect(ui.backDepth()).toBe(0);
  });
});

describe('ui.closePanel / forgetPanel', () => {
  it('画面のボタンで閉じたら、その分の履歴も消える', () => {
    ui.openThread('t1');
    ui.closePanel();
    expect(ui.backDepth()).toBe(0);
  });

  it('消えたパネルは、戻る操作で開き直さない', () => {
    ui.openThread('t1');
    ui.openReplyTree('m1', 't1');
    ui.forgetPanel((p) => p.kind === 'thread' && p.id === 't1');
    ui.back();
    expect(ui.panel).toBeNull();
    expect(ui.backDepth()).toBe(0);
  });
});

describe('ui.openSearch / closeSearch', () => {
  it('検索を始めるとチャットに戻り、閉じると戻る操作の層も消える', () => {
    reset(false);
    ui.tab = 'settings';
    const tick = ui.searchFocusTick;
    ui.openSearch();
    expect(ui.tab).toBe('chat');
    expect(ui.searchOpen).toBe(true);
    expect(ui.searchFocusTick).toBe(tick + 1);
    ui.closeSearch();
    expect(ui.searchOpen).toBe(false);
    // 設定から来たので、戻ると設定へ
    expect(ui.backDepth()).toBe(2);
    ui.back();
    expect(ui.tab).toBe('settings');
  });
});
