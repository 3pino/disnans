import { getItem, setItem } from '../storage';
import { DEFAULT_NAV_ITEMS, normalizeNavItems, normalizeNavLabels, setNavLabel } from '../navBar';

// ナビゲーションバーの項目（端末ごと）。サーバーには送らない（storage の localStorage に置く）。deviceKind.svelte.ts と同じ置き方
const KEY = 'disnans.navBarItems';
// 項目ごとの表示名（端末ごと）。キーがない項目は未設定（既定の名前）、"" は設定済みで空欄（コマンド名）
const LABEL_KEY = 'disnans.navBarLabels';

function load(): string[] {
  try {
    const raw = getItem(KEY);
    return normalizeNavItems(raw === null ? null : (JSON.parse(raw) as unknown));
  } catch {
    return [...DEFAULT_NAV_ITEMS];
  }
}

function loadLabels(): Record<string, string> {
  try {
    const raw = getItem(LABEL_KEY);
    return normalizeNavLabels(raw === null ? null : (JSON.parse(raw) as unknown));
  } catch {
    return {};
  }
}

class NavBarStore {
  private current = $state<string[]>(load());
  private currentLabels = $state<Record<string, string>>(loadLabels());

  /** 並べている項目の ID（出さないものも含む。リアクティブ） */
  get items(): string[] {
    return this.current;
  }

  /** 項目ごとの表示名（設定したものだけ。リアクティブ） */
  get labels(): Record<string, string> {
    return this.currentLabels;
  }

  /** 並びを変える */
  set(items: string[]): void {
    const next = normalizeNavItems(items);
    this.current = next;
    setItem(KEY, JSON.stringify(next));
  }

  /** 項目の表示名を設定する（空欄なら「設定済みで空欄」として残す） */
  setLabel(id: string, text: string): void {
    const next = setNavLabel(this.currentLabels, id, text);
    this.currentLabels = next;
    setItem(LABEL_KEY, JSON.stringify(next));
  }

  /** 表示名をすべて既定に戻す（未設定に戻す） */
  resetLabels(): void {
    this.currentLabels = {};
    setItem(LABEL_KEY, null);
  }

  /** 並びを既定に戻す */
  reset(): void {
    this.current = [...DEFAULT_NAV_ITEMS];
    setItem(KEY, null);
  }
}

export const navBar = new NavBarStore();
