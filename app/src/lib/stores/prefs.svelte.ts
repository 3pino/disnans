import { api } from '../api';
import { getItem, setItem } from '../storage';
import { normalizeEnterKeys, type EnterAction, type EnterCombo, type EnterKeyPrefs } from '../enterKeys';
import { normalizeHotkeys, type HotkeyOverrides } from '../commands.svelte';
import { normalizeSlashAliases, setSlashAlias, type SlashAliases } from '../slashAlias';
import { normalizeComposerMenu, type ComposerMenuPrefs } from '../composerMenu';
import { normalizeMessageLayout, type MessageLayout } from '../messageLayout';
import { client } from './client.svelte';
import { ui } from './ui.svelte';

/** 起動したときにすぐ使えるように、最後に読んだものを端末にも置いておく */
const CACHE_KEY = 'disnans.prefs';

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function loadCache(): Raw {
  try {
    const v = JSON.parse(getItem(CACHE_KEY) ?? '{}') as unknown;
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * ユーザーごとの設定（ホットキー・スラッシュコマンドの別名・Enter キーの動作など）。サーバー（/api/me/prefs）に置き、同じユーザーの端末で共有する。
 * 中身は JSON のオブジェクトで、知らない項目（新しい版が足したものなど）もそのまま残して保存する
 */
class Prefs {
  private raw = $state.raw<Raw>(loadCache());
  /** 保存中の数（その間に届いた prefs.updated は、自分の保存の知らせなので無視する） */
  private saving = 0;
  private started = false;

  /** コマンド ID → ホットキーの一覧（空の一覧は「なし」。項目がなければ既定）。古い1つだけの形も読む */
  readonly hotkeys = $derived<HotkeyOverrides>(normalizeHotkeys(this.raw.hotkeys));
  /** コマンド ID → スラッシュコマンドの別名（項目がなければ元の名前） */
  readonly slashNames = $derived<SlashAliases>(normalizeSlashAliases(this.raw.slashNames));
  readonly enterKeys = $derived<EnterKeyPrefs>(normalizeEnterKeys(this.raw.enterKeys));
  /** 入力欄の「＋」メニューの並び順と出す項目 */
  readonly composerMenu = $derived(normalizeComposerMenu(this.raw.composerMenu));
  /** メッセージの表示（リスト・吹き出し）。既定はリスト */
  readonly messageLayout = $derived<MessageLayout>(normalizeMessageLayout(this.raw.messageLayout));

  /** 接続を始めたあとに1回呼ぶ。hello のたびにサーバーから読み直し、ほかの端末での変更を受け取る */
  start(): void {
    if (this.started) return;
    this.started = true;
    client.subscribe((ev) => {
      if (ev.type === 'hello') void this.load();
      else if (ev.type === 'prefs.updated' && this.saving === 0) this.apply(ev.prefs);
    });
    if (client.ready) void this.load();
  }

  private async load(): Promise<void> {
    try {
      const v = await api.prefs();
      if (this.saving === 0) this.apply(v);
    } catch (e) {
      console.warn('設定を読めませんでした', e);
    }
  }

  private apply(v: unknown): void {
    if (!isObject(v)) return;
    this.raw = v;
    setItem(CACHE_KEY, JSON.stringify(v));
  }

  /** 1項目を変えて保存する */
  private async update(key: string, value: unknown): Promise<void> {
    const next = { ...this.raw, [key]: value };
    this.apply(next);
    this.saving++;
    try {
      const saved = await api.setPrefs(next);
      // 保存の途中でさらに変えていなければ、サーバーのものに合わせる
      if (this.saving === 1 && this.raw === next) this.apply(saved);
    } catch (e) {
      ui.toast(`設定を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.saving--;
    }
  }

  /** ホットキーの一覧を設定する。null で既定に戻す、空の一覧で「なし」 */
  setHotkeys(commandId: string, hotkeys: string[] | null): void {
    const next = { ...this.hotkeys };
    if (hotkeys === null) delete next[commandId];
    else next[commandId] = hotkeys;
    void this.update('hotkeys', next);
  }

  /** スラッシュコマンドの別名を付ける（null で元の名前に戻す） */
  setSlashAlias(commandId: string, alias: string | null): void {
    void this.update('slashNames', setSlashAlias(this.slashNames, commandId, alias));
  }

  setEnterAction(combo: EnterCombo, action: EnterAction): void {
    void this.update('enterKeys', { ...this.enterKeys, [combo]: action });
  }

  /** 「＋」メニューの並び順と出さない項目。知らない項目（新しい版が足したものなど）は残す */
  setComposerMenu(next: ComposerMenuPrefs): void {
    const raw = this.raw.composerMenu;
    void this.update('composerMenu', { ...(isObject(raw) ? raw : {}), ...next });
  }

  setMessageLayout(layout: MessageLayout): void {
    void this.update('messageLayout', layout);
  }
}

export const prefs = new Prefs();
