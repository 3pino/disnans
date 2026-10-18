import { prefs } from './prefs.svelte';
import { DEFAULT_NAV_ITEMS, setNavLabel } from '../navBar';

// ナビゲーションバーの項目と表示名（ユーザーごと。prefs に入れ、同じアカウントの端末で共有する）
// 読むときはリアクティブ（prefs の値）。変えるときは prefs に保存する

class NavBarStore {
  /** 並べている項目の ID（出さないものも含む。リアクティブ） */
  get items(): string[] {
    return prefs.navBarItems;
  }

  /** 項目ごとの表示名（設定したものだけ。リアクティブ） */
  get labels(): Record<string, string> {
    return prefs.navBarLabels;
  }

  /** 並びを変える */
  set(items: string[]): void {
    prefs.setNavBarItems(items);
  }

  /** 項目の表示名を設定する（空欄なら「設定済みで空欄」として残す） */
  setLabel(id: string, text: string): void {
    prefs.setNavBarLabels(setNavLabel(prefs.navBarLabels, id, text));
  }

  /** 表示名をすべて既定に戻す（未設定に戻す） */
  resetLabels(): void {
    prefs.setNavBarLabels({});
  }

  /** 並びを既定に戻す */
  reset(): void {
    prefs.setNavBarItems([...DEFAULT_NAV_ITEMS]);
  }
}

export const navBar = new NavBarStore();
