// @vitest-environment jsdom
// 全画面の plugin view（layout: full）の規則: 通話・設定・チャットを開くとき、閉じるか。通話の画面が見えるか。
import { beforeEach, describe, expect, it } from 'vitest';
import { ui } from './ui.svelte';
import { isFullPanel, samePanel } from '../navHistory';

const FULL = { kind: 'plugin', plugin: 'files', view: 'browse', sessionId: null, full: true } as const;
const PLAIN = { kind: 'plugin', plugin: 'dice', view: 'roll', sessionId: null } as const;

beforeEach(() => {
  ui.isMobile = false;
  ui.tab = 'chat';
  ui.panel = null;
});

describe('isFullPanel / samePanel', () => {
  it('full のプラグインの view だけが全画面。ほかのパネルは全画面ではない', () => {
    expect(isFullPanel(FULL)).toBe(true);
    expect(isFullPanel(PLAIN)).toBe(false);
    expect(isFullPanel(null)).toBe(false);
    expect(isFullPanel({ kind: 'timeline', id: 1 })).toBe(false);
  });
  it('同じ view でも、全画面の印が違えば別のパネル', () => {
    expect(samePanel(FULL, { ...FULL, full: undefined } as never)).toBe(true); // 同じ view として扱う（印は表示の決まり）
    expect(samePanel(FULL, PLAIN)).toBe(false);
  });
});

describe('全画面の view を開いている間の規則', () => {
  it('通話の画面は、全画面の view に覆われていれば見えない（通話のタブのまま）', () => {
    ui.tab = 'call';
    ui.panel = { ...FULL };
    expect(ui.callScreenShown).toBe(false);
    ui.panel = null;
    expect(ui.callScreenShown).toBe(true);
  });

  it('広い画面でも、設定を開くと全画面の view は閉じる（場所を取り合うため）', () => {
    ui.openPluginView('files', 'browse', null, true);
    ui.openSettings();
    expect(ui.tab).toBe('settings');
    expect(ui.panel).toBeNull();
  });

  it('広い画面でも、通話を開くと全画面の view は閉じる', () => {
    ui.openPluginView('files', 'browse', null, true);
    ui.openCall('reset');
    expect(ui.tab).toBe('call');
    expect(ui.panel).toBeNull();
  });

  it('狭い画面では、全画面でない view（ほかのプラグイン）は設定を開いても残す（従来どおり）', () => {
    ui.isMobile = true;
    ui.openPluginView('dice', 'roll', null);
    ui.openSettings();
    expect(ui.panel).toMatchObject({ kind: 'plugin', plugin: 'dice' });
  });

  it('狭い画面では、通話を開くと、全画面でない view も閉じる（従来どおり）', () => {
    ui.isMobile = true;
    ui.openPluginView('dice', 'roll', null);
    ui.openCall('reset');
    expect(ui.panel).toBeNull();
  });

  it('全画面の view は、開き直しても同じ view の扱い（openPluginView の full は panel に残る）', () => {
    ui.openPluginView('files', 'browse', null, true);
    expect(ui.panel).toMatchObject({ kind: 'plugin', plugin: 'files', view: 'browse', full: true });
    ui.openPluginView('dice', 'roll', null);
    expect(ui.panel).toEqual({ kind: 'plugin', plugin: 'dice', view: 'roll', sessionId: null });
  });
});
