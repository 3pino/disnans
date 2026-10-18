import { api } from '../api';
import { getItem, setItem } from '../storage';
import { normalizeEnterKeys, type EnterAction, type EnterCombo, type EnterKeyPrefs } from '../enterKeys';
import { normalizeHotkeys, type HotkeyOverrides } from '../commands.svelte';
import { normalizeSlashAliases, setSlashAlias, type SlashAliases } from '../slashAlias';
import { migrateComposerMenu, normalizeComposerMenu, type ComposerMenuPrefs } from '../composerMenu';
import { normalizeMessageLayout, type MessageLayout } from '../messageLayout';
import { normalizeNavItems, normalizeNavLabels } from '../navBar';
import { parseCallSettings, type CallSettingsData } from '../call/pure';
import { CALL_USER_KEYS, USER_KEYS, legacyUserValues, normalizeTheme, reportSettingsError, type Raw, type ThemeChoice } from '../settingsModel';
import { client } from './client.svelte';

/** 起動したときにすぐ使えるように、最後に読んだものを端末にも置いておく */
const CACHE_KEY = 'disnans.prefs';

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

/** composerMenu を新しい版へ移す（移した値を返す。保存は呼び出し側）。ほかの項目はそのまま */
function migrateRaw(v: Raw): { value: Raw; changed: boolean } {
  const m = migrateComposerMenu(v.composerMenu);
  return { value: { ...v, composerMenu: m.value }, changed: m.changed };
}

/**
 * ユーザーごとの設定。サーバー（/api/me/prefs）に置き、同じユーザーの端末で共有する。
 * ホットキー・スラッシュコマンドの別名・Enter キー・「＋」メニュー・メッセージの表示のほか、
 * テーマ・選んだテーマ・ナビゲーションバーの項目と表示名・通話の機器によらない設定を入れる。
 * 中身は JSON のオブジェクトで、知らない項目（新しい版が足したものなど）もそのまま残して保存する。
 */
export class Prefs {
  // 起動直後の値: 端末のキャッシュ（無ければ、以前の端末の値）。サーバーの値が届くと置き換わる
  private raw = $state.raw<Raw>(migrateRaw({ ...legacyUserValues((key) => getItem(key)), ...loadCache() }).value);
  /** 保存中の数（その間に届いた prefs.updated は、自分の保存の知らせなので無視する） */
  private saving = 0;
  private started = false;
  private listeners = new Set<() => void>();

  /** コマンド ID → ホットキーの一覧（空の一覧は「なし」。項目がなければ既定）。古い1つだけの形も読む */
  readonly hotkeys = $derived<HotkeyOverrides>(normalizeHotkeys(this.raw.hotkeys));
  /** コマンド ID → スラッシュコマンドの別名（項目がなければ元の名前） */
  readonly slashNames = $derived<SlashAliases>(normalizeSlashAliases(this.raw.slashNames));
  readonly enterKeys = $derived<EnterKeyPrefs>(normalizeEnterKeys(this.raw.enterKeys));
  /** 入力欄の「＋」メニューの並び順と出す項目 */
  readonly composerMenu = $derived(normalizeComposerMenu(this.raw.composerMenu));
  /** メッセージの表示（リスト・吹き出し）。既定はリスト */
  readonly messageLayout = $derived<MessageLayout>(normalizeMessageLayout(this.raw.messageLayout));
  /** テーマ（system・light・dark）。起動直後は端末のキャッシュの値 */
  readonly theme = $derived<ThemeChoice>(normalizeTheme(this.raw.theme));
  /** 選んだプラグインのテーマの ID（なければ null） */
  readonly customTheme = $derived<string | null>(typeof this.raw.customTheme === 'string' && this.raw.customTheme !== '' ? this.raw.customTheme : null);
  /** ナビゲーションバーの項目の並び（出さないものも含む） */
  readonly navBarItems = $derived<string[]>(normalizeNavItems(this.raw.navBarItems));
  /** ナビゲーションバーの項目ごとの表示名（設定したものだけ） */
  readonly navBarLabels = $derived<Record<string, string>>(normalizeNavLabels(this.raw.navBarLabels));
  /** 通話の設定のうち、ユーザー共通のもの（機器の項目は含まない） */
  readonly callUser = $derived<CallSettingsData>(parseCallSettings(this.raw));

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

  /** 値が変わったとき（読み込み・変更のあと）に呼ぶ関数を登録する。返り値で外す */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async load(): Promise<void> {
    try {
      const v = await api.prefs();
      if (this.saving !== 0) return;
      this.apply(v);
      // サーバーに無い項目だけ、以前の端末の値を一度取り込む（既にある値は上書きしない）
      const legacy = legacyUserValues((key) => getItem(key));
      const missing: Raw = {};
      for (const k of USER_KEYS) if (!(k in this.raw) && k in legacy) missing[k] = legacy[k];
      if (Object.keys(missing).length > 0) void this.merge(missing);
    } catch (e) {
      console.warn('設定を読めませんでした', e);
    }
  }

  private apply(v: unknown): void {
    if (!isObject(v)) return;
    const m = migrateRaw(v);
    this.raw = m.value;
    setItem(CACHE_KEY, JSON.stringify(m.value));
    // 古い版の保存値を移したときは、サーバーにも書き直す（一度きり。移したあとの値は版の印を持つ）
    if (m.changed && this.saving === 0) void this.merge({ composerMenu: m.value.composerMenu });
    this.notify();
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('設定の購読で例外', e);
      }
    }
  }

  /** 項目をまとめて変えて保存する（まず手元に反映し、サーバーの返事に合わせる） */
  private async merge(patch: Raw): Promise<void> {
    const next = { ...this.raw, ...patch };
    this.apply(next);
    this.saving++;
    try {
      const saved = await api.setPrefs(next);
      // 保存の途中でさらに変えていなければ、サーバーのものに合わせる
      if (this.saving === 1 && this.raw === next) this.apply(saved);
    } catch (e) {
      reportSettingsError(`設定を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.saving--;
    }
  }

  /** 1項目を変えて保存する */
  private update(key: string, value: unknown): Promise<void> {
    return this.merge({ [key]: value });
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

  setTheme(theme: ThemeChoice): void {
    void this.update('theme', theme);
  }

  /** 選んだプラグインのテーマ（null で「テーマなし」） */
  setCustomTheme(id: string | null): void {
    void this.update('customTheme', id);
  }

  setNavBarItems(items: string[]): void {
    void this.update('navBarItems', normalizeNavItems(items));
  }

  setNavBarLabels(labels: Record<string, string>): void {
    void this.update('navBarLabels', normalizeNavLabels(labels));
  }

  /** 通話のユーザー共通の設定のうち、渡したものだけ変える */
  setCallUser(patch: Partial<CallSettingsData>): void {
    const next: Raw = {};
    for (const k of CALL_USER_KEYS) if (k in patch) next[k] = patch[k];
    if (Object.keys(next).length > 0) void this.merge(next);
  }
}

export const prefs = new Prefs();
