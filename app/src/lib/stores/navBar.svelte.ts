import { getItem, setItem } from '../storage';
import { DEFAULT_NAV_ITEMS, normalizeNavItems } from '../navBar';

// ナビゲーションバーの項目（端末ごと）。サーバーには送らない（storage の localStorage に置く）。deviceKind.svelte.ts と同じ置き方
const KEY = 'disnans.navBarItems';

function load(): string[] {
  try {
    const raw = getItem(KEY);
    return normalizeNavItems(raw === null ? null : (JSON.parse(raw) as unknown));
  } catch {
    return [...DEFAULT_NAV_ITEMS];
  }
}

class NavBarStore {
  private current = $state<string[]>(load());

  /** 並べている項目の ID（出さないものも含む。リアクティブ） */
  get items(): string[] {
    return this.current;
  }

  /** 並びを変える */
  set(items: string[]): void {
    const next = normalizeNavItems(items);
    this.current = next;
    setItem(KEY, JSON.stringify(next));
  }

  /** 既定に戻す */
  reset(): void {
    this.current = [...DEFAULT_NAV_ITEMS];
    setItem(KEY, null);
  }
}

export const navBar = new NavBarStore();
