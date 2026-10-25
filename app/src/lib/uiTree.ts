// 画面の構造（GUI と TUI の共通の木）の型と、GUI での出し分け。
// 木の正は crates/client-core/src/view/ui.rs で、ここへは uiTree.generated.ts として届く（説明は docs/UI_TREE.md）。
// 値は木に入っていない。設定の値の読み書きは lib/settingsBindings.svelte.ts、描画は components/SettingsTree.svelte

import { SETTINGS_PAGES } from './uiTree.generated';

/** GUI で出す条件（view::ui::Gui） */
export type UiGui = 'always' | 'never' | 'android' | 'notAndroid' | 'tauri' | 'tauriOrDev';
export type UiShow = { gui: UiGui; tui: boolean };

export type UiOpt = { value: string; label: string; icon: string | null };

export type UiControl =
  | { type: 'toggle' }
  | { type: 'segmented'; options: UiOpt[] }
  | { type: 'select'; options: UiOpt[] }
  | { type: 'slider'; min: number; max: number; step: number; scale: number; unit: string };

export type UiField = { type: 'field'; id: string; label: string; icon: string | null; key: string; control: UiControl; show: UiShow };
export type UiLink = { type: 'link'; id: string; label: string; page: string; show: UiShow };
export type UiSlot = { type: 'slot'; id: string; show: UiShow };
export type UiNote = { type: 'note'; id: string; text: string; show: UiShow };
export type UiItem = UiField | UiLink | UiSlot | UiNote;

export type UiSection = { id: string; title: string; items: UiItem[]; show: UiShow };
export type UiPage = { id: string; title: string; sections: UiSection[]; show: UiShow };

export type UiNavItem = { id: string; label: string | null; name: string; tui: boolean };

/** 設定のトップのページ（view::ui::SETTINGS_TOP） */
export const SETTINGS_TOP = 'top';

/** GUI の環境（Tauri か・Android の Tauri か・開発ユーザーか） */
export type GuiEnv = { tauri: boolean; android: boolean; devUser: boolean };

/** この環境の GUI に出すか */
export function shownOnGui(show: UiShow, env: GuiEnv): boolean {
  switch (show.gui) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'android':
      return env.tauri && env.android;
    case 'notAndroid':
      return !env.android;
    case 'tauri':
      return env.tauri;
    case 'tauriOrDev':
      return env.tauri || env.devUser;
  }
}

/** ページを ID で探す */
export function settingsPage(id: string): UiPage | undefined {
  return SETTINGS_PAGES.find((p) => p.id === id);
}

/** GUI に出す節と項目だけにしたページ（項目が 1 つも残らない節は出さない） */
export function guiSections(page: UiPage, env: GuiEnv): UiSection[] {
  return page.sections
    .filter((s) => shownOnGui(s.show, env))
    .map((s) => ({ ...s, items: s.items.filter((i) => shownOnGui(i.show, env)) }))
    .filter((s) => s.items.length > 0);
}
