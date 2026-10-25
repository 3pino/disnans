import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, NAV_ITEMS } from './uiTree.generated';
import { guiSections, settingsPage, shownOnGui, SETTINGS_TOP, type GuiEnv, type UiItem } from './uiTree';
import { BOUND_KEYS } from './settingsBindings.svelte';
import { DEFAULT_NAV_LABELS, NAV_CHAT_ID, NAV_SETTINGS_ID } from './navBar';

const ENVS: GuiEnv[] = [
  { tauri: true, android: false, devUser: false },
  { tauri: true, android: true, devUser: false },
  { tauri: false, android: false, devUser: true },
  { tauri: false, android: false, devUser: false },
];

function guiItems(): UiItem[] {
  return SETTINGS_PAGES.flatMap((p) => ENVS.flatMap((env) => (shownOnGui(p.show, env) ? guiSections(p, env).flatMap((s) => s.items) : [])));
}

describe('設定の木（core の view::ui の生成物）', () => {
  it('先頭はトップのページ', () => {
    expect(SETTINGS_PAGES[0].id).toBe(SETTINGS_TOP);
    expect(settingsPage(SETTINGS_TOP)?.title).toBe('設定');
  });

  it('GUI に出す Field は、どれも読み書きの先がある', () => {
    for (const item of guiItems()) {
      if (item.type === 'field') expect(BOUND_KEYS, item.key).toContain(item.key);
    }
  });

  it('GUI に出す Slot は、どれも SettingsView が描く', () => {
    const source = readFileSync(new URL('../components/SettingsView.svelte', import.meta.url), 'utf8');
    for (const item of guiItems()) {
      if (item.type === 'slot') expect(source, item.id).toContain(`item.id === '${item.id}'`);
    }
  });

  it('GUI に出す Link の行き先は、GUI に出すページ', () => {
    for (const env of ENVS) {
      for (const s of guiSections(settingsPage(SETTINGS_TOP)!, env)) {
        for (const item of s.items) {
          if (item.type !== 'link') continue;
          const page = settingsPage(item.page);
          expect(page && shownOnGui(page.show, env), item.page).toBe(true);
        }
      }
    }
  });

  it('出し分け: Android だけの項目・TUI だけの項目', () => {
    const ids = (env: GuiEnv) => guiSections(settingsPage(SETTINGS_TOP)!, env).flatMap((s) => s.items.map((i) => i.id));
    expect(ids(ENVS[1])).toContain('orientation');
    expect(ids(ENVS[0])).not.toContain('orientation');
    expect(ids(ENVS[0])).toContain('hotkeys');
    expect(ids(ENVS[1])).not.toContain('hotkeys');
    expect(ids(ENVS[0])).not.toContain('tuiKeys');
    // 接続の節は Tauri か開発ユーザーのとき。デバイスは Tauri だけ
    expect(ids(ENVS[2])).toContain('server');
    expect(ids(ENVS[2])).not.toContain('devices');
    expect(ids(ENVS[3])).not.toContain('server');
  });

  it('ナビの既定の表示名は木から作る', () => {
    expect(DEFAULT_NAV_LABELS[NAV_CHAT_ID]).toBe('Chat');
    expect(DEFAULT_NAV_LABELS[NAV_SETTINGS_ID]).toBe('Settings');
    expect(Object.keys(DEFAULT_NAV_LABELS).sort()).toEqual(NAV_ITEMS.filter((i) => i.label !== null).map((i) => i.id).sort());
  });
});
