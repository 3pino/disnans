import type { AuthorView } from '../author';
import { getItem, setItem } from '../storage';
import { setNavigationBarHidden, syncSystemBars } from '../systemBars';
import type { User } from '../protocol/User';

export type ThemePref = 'system' | 'light' | 'dark';

/** 右側のパネル（モバイルでは全画面）。スレッド、メッセージの集合（timeline。lib/stores/timelinePanel.svelte.ts）、プラグインの view */
export type Panel =
  | { kind: 'thread'; id: string }
  | { kind: 'timeline'; id: number }
  | { kind: 'plugin'; plugin: string; view: string; sessionId: string }
  | null;

/** 設定の中のサブページ（一覧の代わりに出す）。入力欄のキー・ホットキー・ナビゲーションバー・＋メニュー・通話 */
export type SettingsSubpage = 'enterKeys' | 'hotkeys' | 'navBar' | 'composerMenu' | 'call';

/** トーストの先頭に出す、送った人のアイコン（AuthorAvatar で描く。ボットならプラグインのアイコン） */
export type ToastAvatar = { author: AuthorView; user?: User; id: string };

export type Toast = {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
  avatar?: ToastAvatar;
};

export type ConfirmRequest = {
  title: string;
  body?: string;
  okLabel: string;
  /** 取り消すボタンの文字（省くと「キャンセル」） */
  ngLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
};

const THEME_KEY = 'disnans.theme';
const HIDE_NAV_BAR_KEY = 'disnans.hideNavigationBar';
const MOBILE_QUERY = '(max-width: 767px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';

class Ui {
  theme = $state<ThemePref>((getItem(THEME_KEY) as ThemePref | null) ?? 'system');
  /** Android のナビゲーションバーを隠す（その端末にだけ保存する） */
  hideNavigationBar = $state(getItem(HIDE_NAV_BAR_KEY) === '1');
  isMobile = $state(false);
  /** モバイルのボトムナビ。デスクトップでは chat と settings だけを使う */
  tab = $state<'chat' | 'threads' | 'settings' | 'call'>('chat');
  panel = $state<Panel>(null);
  /** 設定で開いているプラグインの設定画面（プラグインの ID）。設定のタブでだけ使う */
  pluginSettings = $state<string | null>(null);
  /** 設定で開いている「操作」のサブページ。設定のタブでだけ使う */
  settingsSub = $state<SettingsSubpage | null>(null);
  lightbox = $state<{ src: string; alt: string; downloadUrl: string } | null>(null);
  /** メッセージ検索中か（コマンドで入る。メインチャットの入力欄が検索モードになり、タイムラインが結果に絞り込まれる） */
  searchOpen = $state(false);
  /** 検索中にもう一度コマンドを実行したとき、検索欄にフォーカスを戻すための合図 */
  searchFocusTick = $state(0);
  toasts = $state<Toast[]>([]);
  confirmReq = $state<ConfirmRequest | null>(null);
  /** インライン編集中のメッセージ */
  editing = $state<string | null>(null);
  /** 一覧で名前と時刻を出しているメッセージの ID（画面全体で1つだけ。別のものを出すと前のものは消える） */
  headerMessage = $state<string | null>(null);
  /** 相対時刻の表示を更新するための現在時刻 */
  now = $state(Date.now());
  private toastSeq = 0;

  init(): void {
    const mq = window.matchMedia(MOBILE_QUERY);
    this.isMobile = mq.matches;
    mq.addEventListener('change', (e) => (this.isMobile = e.matches));
    setInterval(() => (this.now = Date.now()), 30_000);
    // 「自動」のときはシステムの切り替えにも追従する
    window.matchMedia(DARK_QUERY).addEventListener('change', () => this.applyTheme());
    this.applyTheme();
    if (this.hideNavigationBar) void setNavigationBarHidden(true).catch((e) => console.error('ナビゲーションバーを隠せませんでした', e));
  }

  setHideNavigationBar(hidden: boolean): void {
    this.hideNavigationBar = hidden;
    setItem(HIDE_NAV_BAR_KEY, hidden ? '1' : null);
    void setNavigationBarHidden(hidden).catch((e) => this.toast(`ナビゲーションバーを切り替えられませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }

  setTheme(t: ThemePref): void {
    this.theme = t;
    setItem(THEME_KEY, t === 'system' ? null : t);
    this.applyTheme();
  }

  private applyTheme(): void {
    const el = document.documentElement;
    if (this.theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', this.theme);
    const dark = this.theme === 'system' ? window.matchMedia(DARK_QUERY).matches : this.theme === 'dark';
    syncSystemBars(dark);
  }

  openThread(id: string): void {
    if (!this.isMobile && this.tab === 'settings') this.tab = 'chat';
    this.panel = { kind: 'thread', id };
  }

  /** メッセージの集合のパネルを開く（中身は timelinePanels の id で引く） */
  openTimeline(id: number): void {
    if (!this.isMobile && this.tab === 'settings') this.tab = 'chat';
    this.panel = { kind: 'timeline', id };
  }

  /** プラグインの view でセッションを開く */
  openPluginView(plugin: string, view: string, sessionId: string): void {
    if (!this.isMobile && this.tab === 'settings') this.tab = 'chat';
    this.panel = { kind: 'plugin', plugin, view, sessionId };
  }

  /** メッセージ検索を始める（メインチャットを見せる。モバイルでパネルが開いていれば閉じる） */
  openSearch(): void {
    if (this.tab !== 'chat') {
      this.tab = 'chat';
      this.pluginSettings = null;
      this.settingsSub = null;
    }
    if (this.isMobile) this.panel = null;
    this.searchOpen = true;
    this.searchFocusTick++;
  }

  /** 検索を終えて通常の入力欄・タイムラインに戻る */
  closeSearch(): void {
    this.searchOpen = false;
  }

  /** 設定を開く。設定を開いているときにもう一度押したら、プラグインの設定画面から一覧に戻る */
  openSettings(): void {
    this.tab = 'settings';
    this.pluginSettings = null;
    this.settingsSub = null;
    if (!this.isMobile) this.panel = null;
  }

  /** 通話の画面（全画面版）を開く。モバイルではスレッドなどのパネルを閉じる */
  openCall(): void {
    this.tab = 'call';
    this.pluginSettings = null;
    this.settingsSub = null;
    if (this.isMobile) this.panel = null;
  }

  /** 設定の中で、プラグインの設定画面を開く */
  openPluginSettings(id: string): void {
    this.tab = 'settings';
    this.settingsSub = null;
    this.pluginSettings = id;
  }

  closePluginSettings(): void {
    this.pluginSettings = null;
  }

  /** 設定の中で、「操作」のサブページ（入力欄のキーなど）を開く */
  openSettingsSub(page: SettingsSubpage): void {
    this.tab = 'settings';
    this.pluginSettings = null;
    this.settingsSub = page;
  }

  closeSettingsSub(): void {
    this.settingsSub = null;
  }

  /**
   * 戻る操作で閉じられるもの（下から順）。Android の戻るボタンは、これを上から1つずつ閉じる。
   * チャット以外のタブ → 設定のサブページ・プラグインの設定画面 → パネル → プラグインの層（画面共有の閲覧など）→ 検索 → 画像の全画面（一番上）。何も開いていなければ空
   */
  backLayers(): (() => void)[] {
    const layers: (() => void)[] = [];
    if (this.tab !== 'chat')
      layers.push(() => {
        this.tab = 'chat';
        this.pluginSettings = null;
        this.settingsSub = null;
      });
    if (this.tab === 'settings' && this.pluginSettings) layers.push(() => this.closePluginSettings());
    if (this.tab === 'settings' && this.settingsSub) layers.push(() => this.closeSettingsSub());
    if (this.panel) layers.push(() => this.closePanel());
    for (const b of this.pluginBack) layers.push(b.run);
    if (this.searchOpen) layers.push(() => this.closeSearch());
    // 画像の全画面は一番上（戻る操作で、まず全画面を解除する）
    if (this.lightbox) layers.push(() => (this.lightbox = null));
    return layers;
  }

  closePanel(): void {
    this.panel = null;
  }

  /**
   * プラグインが登録した「戻る」で閉じるもの（`disnans.ui.onBack`。API v9）。古い順。
   * 戻る操作では、パネルなど本体の層よりも上（先）に閉じる。返り値の関数で外す
   */
  pluginBack = $state<{ run: () => void }[]>([]);

  addPluginBack(run: () => void): () => void {
    const entry = { run };
    this.pluginBack = [...this.pluginBack, entry];
    return () => {
      this.pluginBack = this.pluginBack.filter((e) => e !== entry);
    };
  }

  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 5000, avatar?: ToastAvatar): void {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, kind, action, avatar });
    setTimeout(() => this.dismiss(id), ms);
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  confirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirmReq = {
        ...opts,
        resolve: (ok) => {
          this.confirmReq = null;
          resolve(ok);
        },
      };
    });
  }
}

export const ui = new Ui();
