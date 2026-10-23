import { api } from '../api';
import { getItem, setItem } from '../storage';
import { DEFAULT_ENTER_KEYS, type EnterAction, type EnterCombo, type EnterKeyPrefs } from '../enterKeys';
import type { HotkeyOverrides } from '../commands.svelte';
import { setSlashAlias, type SlashAliases } from '../slashAlias';
import { migrateComposerMenu, type ComposerMenuPrefs } from '../composerMenu';
import { DEFAULT_MESSAGE_LAYOUT, type MessageLayout } from '../messageLayout';
import { DEFAULT_CALL_SETTINGS, type CallSettingsData } from '../call/pure';
import {
  CALL_USER_KEYS,
  USER_KEYS,
  fillUserDefaults,
  legacyUserValues,
  reportSettingsError,
  type PrefsResult,
  type Raw,
  type ThemeChoice,
} from '../settingsModel';
import { client } from './client.svelte';
import { createRefreshGate } from '../refreshGate';

/** 起動したときにすぐ使えるように、最後に読んだもの（raw と view）をデバイスにも置いておく */
const CACHE_KEY = 'disnans.prefs';

function isObject(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** キャッシュ。版が古いものは、元のオブジェクトだけ（raw と同じ）だった */
function loadCache(): { raw?: Raw; view?: Raw } {
  try {
    const v = JSON.parse(getItem(CACHE_KEY) ?? '{}') as unknown;
    if (!isObject(v)) return {};
    if (isObject(v.raw) && isObject(v.view)) return { raw: v.raw, view: v.view };
    return { raw: v };
  } catch {
    return {};
  }
}

/** composerMenu を新しい版へ移す（移した値を返す。保存は呼び出し側）。ほかの項目はそのまま */
function migrateRaw(v: Raw): { value: Raw; changed: boolean } {
  const m = migrateComposerMenu(v.composerMenu);
  return { value: { ...v, composerMenu: m.value }, changed: m.changed };
}

/** 起動直後の raw と view: キャッシュ → 以前のデバイスの値の順に、無いものは既定で埋める（正規化はしない） */
function bootValues(): { raw: Raw; view: Raw } {
  const legacy = legacyUserValues((key) => getItem(key));
  const cached = loadCache();
  return {
    raw: migrateRaw({ ...legacy, ...(cached.raw ?? {}) }).value,
    view: fillUserDefaults({ ...legacy, ...(cached.view ?? cached.raw ?? {}) }),
  };
}

const BOOT = bootValues();

/** 通話のユーザー共通の項目だけを取り出す（既定の通話の設定に重ねる） */
function callUserOf(view: Raw): CallSettingsData {
  const out: Raw = { ...DEFAULT_CALL_SETTINGS };
  for (const k of CALL_USER_KEYS) if (k in view) out[k] = view[k];
  return out as unknown as CallSettingsData;
}

/**
 * ユーザーごとの設定。サーバー（/api/me/prefs）に置き、同じユーザーのデバイスで共有する。
 * 表示は view（Rust が正規化したもの）から読み、保存は raw（サーバーの元のオブジェクト）に変えた項目を足して送る。
 * 変更は手元の view に型のついた値を直接入れて、サーバーの応答で両方を置き換える。
 * 中身は JSON のオブジェクトで、知らない項目（新しい版が足したものなど）も raw にそのまま残す。
 */
export class Prefs {
  /** サーバーの元のオブジェクト（保存の下地。既定では埋めない） */
  private raw = $state.raw<Raw>(BOOT.raw);
  /** 表示に使う値（Rust の正規化の結果。足りない項目は既定で埋める） */
  private view = $state.raw<Raw>(BOOT.view);
  /** 保存中の数（その間に届いた prefs.updated は、自分の保存の知らせなので無視する） */
  private saving = 0;
  private started = false;
  private listeners = new Set<() => void>();
  private gate: { allow(): boolean };

  constructor(now?: () => number) {
    this.gate = createRefreshGate(now);
  }

  /** コマンド ID → ホットキーの一覧（空の一覧は「なし」。項目がなければ既定） */
  readonly hotkeys = $derived(this.view.hotkeys as HotkeyOverrides);
  /** コマンド ID → スラッシュコマンドの別名（項目がなければ元の名前） */
  readonly slashNames = $derived(this.view.slashNames as SlashAliases);
  readonly enterKeys = $derived((this.view.enterKeys ?? DEFAULT_ENTER_KEYS) as EnterKeyPrefs);
  /** 入力欄の「＋」メニューの並び順と出す項目 */
  readonly composerMenu = $derived(this.view.composerMenu as ComposerMenuPrefs);
  /** メッセージの表示は一覧に固定（吹き出しは撤去。保存された旧い値は見ない） */
  readonly messageLayout: MessageLayout = DEFAULT_MESSAGE_LAYOUT;
  /** テーマ（system・light・dark）。起動直後はデバイスのキャッシュの値 */
  readonly theme = $derived(this.view.theme as ThemeChoice);
  /** 選んだプラグインのテーマの ID（なければ null） */
  readonly customTheme = $derived(this.view.customTheme as string | null);
  /** ナビゲーションバーの項目の並び（出さないものも含む） */
  readonly navBarItems = $derived(this.view.navBarItems as string[]);
  /** ナビゲーションバーの項目ごとの表示名（設定したものだけ） */
  readonly navBarLabels = $derived(this.view.navBarLabels as Record<string, string>);
  /** 通話の設定のうち、ユーザー共通のもの（機器の項目は含まない） */
  readonly callUser = $derived(callUserOf(this.view));

  /** 接続を始めたあとに1回呼ぶ。hello のたびにサーバーから読み直し、ほかのデバイスでの変更を受け取る */
  start(): void {
    if (this.started) return;
    this.started = true;
    client.subscribe((ev) => {
      if (ev.type === 'hello') void this.load();
      else if (ev.type === 'prefs.updated' && this.saving === 0) void this.load();
    });
    if (client.ready) void this.load();
  }

  /** 値が変わったとき（読み込み・変更のあと）に呼ぶ関数を登録する。返り値で外す */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * サーバーから読み直す（ウィンドウに戻ったとき）。接続を始める前・保存の途中・最短 REFRESH_MIN_MS の間隔の内は何もしない。
   * 以前の値の取り込みはしない（load の仕事）。
   */
  async refresh(): Promise<void> {
    if (!this.started || this.saving !== 0 || !this.gate.allow()) return;
    try {
      const v = await api.prefs();
      if (this.saving === 0) this.apply(v);
    } catch (e) {
      console.warn('設定を読めませんでした', e);
    }
  }

  private async load(): Promise<void> {
    try {
      const v = await api.prefs();
      if (this.saving !== 0) return;
      this.apply(v);
      // サーバーに無い項目だけ、以前のデバイスの値を一度取り込む（既にある値は上書きしない）
      const legacy = legacyUserValues((key) => getItem(key));
      const missing: Raw = {};
      for (const k of USER_KEYS) if (!(k in this.raw) && k in legacy) missing[k] = legacy[k];
      if (Object.keys(missing).length > 0) void this.merge(missing);
    } catch (e) {
      console.warn('設定を読めませんでした', e);
    }
  }

  private apply(v: PrefsResult): void {
    if (!isObject(v.raw) || !isObject(v.view)) return;
    const m = migrateRaw(v.raw);
    // 足りない項目だけ既定で埋める（値の型は直さない。直すのは Rust の正規化）
    this.set(m.value, fillUserDefaults(v.view));
    // 古い版の保存値を移したときは、サーバーにも書き直す（一度きり。移したあとの値は版の印を持つ）
    if (m.changed && this.saving === 0) void this.merge({ composerMenu: m.value.composerMenu });
  }

  private set(raw: Raw, view: Raw): void {
    this.raw = raw;
    this.view = view;
    setItem(CACHE_KEY, JSON.stringify({ raw, view }));
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

  /** 項目をまとめて変えて保存する（まず手元の raw と view に反映し、サーバーの返事に合わせる） */
  private async merge(patch: Raw): Promise<void> {
    const next = { ...this.raw, ...patch };
    this.set(next, { ...this.view, ...patch });
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

  setTheme(theme: ThemeChoice): void {
    void this.update('theme', theme);
  }

  /** 選んだプラグインのテーマ（null で「テーマなし」） */
  setCustomTheme(id: string | null): void {
    void this.update('customTheme', id);
  }

  setNavBarItems(items: string[]): void {
    void this.update('navBarItems', items);
  }

  setNavBarLabels(labels: Record<string, string>): void {
    void this.update('navBarLabels', labels);
  }

  /** 通話のユーザー共通の設定のうち、渡したものだけ変える */
  setCallUser(patch: Partial<CallSettingsData>): void {
    const next: Raw = {};
    for (const k of CALL_USER_KEYS) if (k in patch) next[k] = patch[k];
    if (Object.keys(next).length > 0) void this.merge(next);
  }
}

export const prefs = new Prefs();
