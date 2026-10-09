// テーマ（SPEC 9.10）: theme.css だけのパッケージ。端末ごとに1つ選び、本体の CSS のあとに <style> で入れる。
// 一覧（配布済み・開発用フォルダ）は PluginHost が持ち、変わるたびに sync() を呼ぶ。

import { api } from '../api';
import { getItem, setItem } from '../storage';
import type { PluginInfo } from '../protocol/PluginInfo';
import type { DevPlugin } from './host.svelte';
import { errorMessage } from './types';

const SELECTED_KEY = 'disnans.customTheme';
/** 選んだテーマの CSS のキャッシュ（起動直後のちらつきを防ぐ） */
const CACHE_KEY = 'disnans.customTheme.cache';
/** キャッシュする CSS の上限（localStorage を圧迫しないように） */
const MAX_CACHE_CHARS = 256 * 1024;

/** テーマの <style> の目印。プラグインの styles.css はこの前に入れる */
export const THEME_STYLE_SELECTOR = 'style[data-disnans-theme]';

/** 適用するテーマ1つ */
type Source = { sig: string; load: () => Promise<string> };

/** 開発用フォルダのテーマとして使えるか */
export function isDevTheme(d: DevPlugin): boolean {
  return d.kind === 'theme' && !!d.manifest && !d.error && d.theme !== null;
}

class ThemeHost {
  /** この端末で選んだテーマの ID（なければ null） */
  selected = $state<string | null>(getItem(SELECTED_KEY));
  /** いま適用しているテーマの ID */
  applied = $state<string | null>(null);
  /** 読み込みのエラー */
  error = $state<string | null>(null);

  private style: HTMLStyleElement | null = null;
  private sig: string | null = null;
  /** 読み込みの順番（古い読み込みの結果を捨てる） */
  private seq = 0;
  private last: { server: PluginInfo[]; dev: DevPlugin[]; devReady: boolean } = { server: [], dev: [], devReady: false };

  /** 起動直後に1回呼ぶ。前回のテーマの CSS をすぐに入れておく（一覧が届いたら sync で確かめ直す） */
  boot(): void {
    if (!this.selected || this.style) return;
    try {
      const cache = JSON.parse(getItem(CACHE_KEY) ?? 'null') as { id?: unknown; css?: unknown } | null;
      if (cache && cache.id === this.selected && typeof cache.css === 'string') this.apply(this.selected, 'cache', cache.css);
    } catch {
      // キャッシュが壊れていたら無視する
    }
  }

  /** 選ぶ（null でテーマなし）。その端末に保存する */
  select(id: string | null): void {
    this.selected = id;
    setItem(SELECTED_KEY, id);
    this.error = null;
    const { server, dev, devReady } = this.last;
    this.sync(server, dev, devReady);
  }

  /**
   * 一覧に合わせて、適用・入れ替え・外すを行う。開発用フォルダのものを優先する。
   * devReady が false（開発用フォルダをまだ読んでいない）のうちは、見つからなくても外さない
   */
  sync(server: PluginInfo[], dev: DevPlugin[], devReady: boolean): void {
    this.last = { server, dev, devReady };
    const id = this.selected;
    if (!id) {
      this.remove();
      return;
    }
    const src = this.find(id, server, dev);
    if (!src) {
      if (devReady) this.remove();
      return;
    }
    if (src.sig === this.sig) return;
    const seq = ++this.seq;
    src.load().then(
      (css) => {
        if (seq !== this.seq || this.selected !== id) return;
        this.error = null;
        this.apply(id, src.sig, css);
      },
      (e: unknown) => {
        if (seq !== this.seq) return;
        this.error = `テーマを読み込めません: ${errorMessage(e)}`;
        console.error(`[theme:${id}]`, e);
      },
    );
  }

  private find(id: string, server: PluginInfo[], dev: DevPlugin[]): Source | null {
    const d = dev.find((x) => x.manifest?.id === id && isDevTheme(x));
    if (d) {
      const css = d.theme ?? '';
      return { sig: `dev:${d.folder}:${d.stamp}`, load: async () => css };
    }
    const p = server.find((x) => x.id === id && x.type === 'theme');
    if (p) return { sig: `server:${p.hash}`, load: () => api.pluginFile(p.id, 'theme.css', p.hash) };
    return null;
  }

  private apply(id: string, sig: string, css: string): void {
    this.style ??= document.createElement('style');
    this.style.dataset.disnansTheme = id;
    this.style.textContent = css;
    // 本体の CSS（と、すでに読み込んだプラグインの styles.css）より後ろに置く
    document.head.append(this.style);
    this.sig = sig;
    this.applied = id;
    setItem(CACHE_KEY, css.length <= MAX_CACHE_CHARS ? JSON.stringify({ id, css }) : null);
  }

  private remove(): void {
    this.seq++;
    this.style?.remove();
    this.style = null;
    this.sig = null;
    this.applied = null;
    setItem(CACHE_KEY, null);
  }
}

export const themeHost = new ThemeHost();
