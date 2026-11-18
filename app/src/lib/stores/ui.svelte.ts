import type { AuthorView } from '../author';
import { setNavigationBarHidden, syncSystemBars } from '../systemBars';
import { prefs } from './prefs.svelte';
import { deviceSettings } from './deviceSettings.svelte';
import { setSettingsErrorHandler } from '../settingsModel';
import type { User } from '../protocol/User';
import type { LightboxItem } from '@3pino/viewer-kit-web/viewers/types';
import { Shell, type ShellConfirm, type ShellToast } from '@3pino/app-kit-web/shell';
import { forgetPanelIn, isFullPanel, navBack, navBackDepth, navigate, normalizeNav, type NavMode, type NavState, type NavTab, type Panel, type SettingsSubpage } from '../navHistory';

export type ThemePref = 'system' | 'light' | 'dark';

export type { Panel, SettingsSubpage, NavTab, NavState, NavMode } from '../navHistory';

/** トーストの先頭に出す、送った人のアイコン（AuthorAvatar で描く。ボットならプラグインのアイコン） */
export type ToastAvatar = { author: AuthorView; user?: User; id: string };

export type Toast = ShellToast<ToastAvatar>;

export type ConfirmRequest = ShellConfirm;

const MOBILE_QUERY = '(max-width: 767px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * 本体の画面の状態。土台（トースト・確認・拡大表示・戻る操作の層）は `shell`（lib/shell/）が持ち、
 * ここには Disnans のこと（タブ・パネル・通話・設定・検索・遷移の履歴）だけを置く。
 * 土台のメンバーは、呼び出し側の書き方を変えないよう、下で `shell` に委ねる。
 */
class Ui {
  /** テーマ（ユーザーごと。prefs の値） */
  get theme(): ThemePref {
    return prefs.theme;
  }
  /** Android のナビゲーションバーを隠す（そのデバイスだけ。deviceSettings の値） */
  get hideNavigationBar(): boolean {
    return deviceSettings.hideNavigationBar;
  }
  isMobile = $state(false);
  /** ナビゲーションバーのタブ（狭い画面では下、広い画面では左に出る） */
  tab = $state<NavTab>('chat');
  panel = $state<Panel>(null);
  /** 設定で開いているプラグインの設定画面（プラグインの ID）。設定のタブでだけ使う */
  pluginSettings = $state<string | null>(null);
  /** 設定で開いている「操作」のサブページ。設定のタブでだけ使う */
  settingsSub = $state<SettingsSubpage | null>(null);
  /** メッセージ検索中か（コマンドで入る。メインチャットの入力欄が検索モードになり、タイムラインが結果に絞り込まれる） */
  searchOpen = $state(false);
  /** 検索中にもう一度コマンドを実行したとき、検索欄にフォーカスを戻すための合図 */
  searchFocusTick = $state(0);
  /** インライン編集中のメッセージ */
  editing = $state<string | null>(null);
  /** 一覧で名前と時刻を出しているメッセージの ID（画面全体で1つだけ。別のものを出すと前のものは消える） */
  headerMessage = $state<string | null>(null);
  /** 相対時刻の表示を更新するための現在時刻 */
  now = $state(Date.now());

  /** 土台の状態（トースト・確認・拡大表示・戻る操作の層）。チャットのことは知らない */
  readonly shell = new Shell<ToastAvatar, LightboxItem>();

  get toasts(): Toast[] {
    return this.shell.toasts;
  }
  set toasts(v: Toast[]) {
    this.shell.toasts = v;
  }
  get confirmReq(): ConfirmRequest | null {
    return this.shell.confirmReq;
  }
  set confirmReq(v: ConfirmRequest | null) {
    this.shell.confirmReq = v;
  }
  /** 拡大表示の画像（いま見ている 1 枚）。開くのは openLightbox で */
  get lightbox(): LightboxItem | null {
    return this.shell.lightbox;
  }
  set lightbox(v: LightboxItem | null) {
    this.shell.lightbox = v;
  }
  /** 拡大表示の前後をたどる一覧。ないときは前後に移れない */
  get lightboxGallery(): (() => LightboxItem[]) | null {
    return this.shell.lightboxGallery;
  }
  set lightboxGallery(v: (() => LightboxItem[]) | null) {
    this.shell.lightboxGallery = v;
  }
  get pluginBack(): { run: () => void }[] {
    return this.shell.pluginBack;
  }
  set pluginBack(v: { run: () => void }[]) {
    this.shell.pluginBack = v;
  }

  init(): void {
    const mq = window.matchMedia(MOBILE_QUERY);
    this.isMobile = mq.matches;
    mq.addEventListener('change', (e) => (this.isMobile = e.matches));
    setInterval(() => (this.now = Date.now()), 30_000);
    // 「自動」のときはシステムの切り替えにも追従する
    window.matchMedia(DARK_QUERY).addEventListener('change', () => this.applyTheme());
    // 設定の失敗は、トーストで知らせる（stores 側は UI に依存しない）
    setSettingsErrorHandler((text) => this.toast(text, 'error'));
    // テーマ・ナビバーを隠す（起動時のキャッシュの値から始め、サーバーの値が届いたら追う）
    $effect.root(() => {
      $effect(() => {
        void this.theme;
        this.applyTheme();
      });
      $effect(() => {
        const hidden = this.hideNavigationBar;
        void setNavigationBarHidden(hidden).catch((e) => console.error('ナビゲーションバーを切り替えられませんでした', e));
      });
    });
  }

  /** ナビゲーションバーを隠すかを、このデバイスに保存する（テーマは prefs.setTheme） */
  setHideNavigationBar(hidden: boolean): void {
    deviceSettings.set('hideNavigationBar', hidden);
  }

  private applyTheme(): void {
    const el = document.documentElement;
    if (this.theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', this.theme);
    const dark = this.theme === 'system' ? window.matchMedia(DARK_QUERY).matches : this.theme === 'dark';
    syncSystemBars(dark);
  }

  // ---- 画面の遷移（履歴は lib/navHistory.ts） ----

  /** 遷移の履歴（古い順）。開く操作で「開く前の状態」を積み、戻る操作（back）で取り出す */
  navStack = $state.raw<NavState[]>([]);

  /** いまの画面の状態 */
  navState(): NavState {
    return normalizeNav({ tab: this.tab, settingsSub: this.settingsSub, pluginSettings: this.pluginSettings, panel: this.panel, searchOpen: this.searchOpen });
  }

  private applyNav(s: NavState): void {
    this.tab = s.tab;
    this.settingsSub = s.settingsSub;
    this.pluginSettings = s.pluginSettings;
    this.panel = s.panel;
    this.searchOpen = s.searchOpen;
  }

  /** いまの状態に patch を当てた画面へ移る（mode は履歴の積み方） */
  navigate(patch: Partial<NavState>, mode: NavMode = 'push'): void {
    const from = this.navState();
    const to = normalizeNav({ ...from, ...patch });
    this.navStack = navigate(this.navStack, from, to, mode);
    this.applyNav(to);
  }

  /** パネルを開く。デスクトップの設定のタブからはチャットに戻す */
  private openPanel(panel: NonNullable<Panel>): void {
    this.navigate({ panel, ...(!this.isMobile && this.tab === 'settings' ? { tab: 'chat' as const } : {}) });
  }

  /** メッセージを起点にした返信のツリーを開く */
  openReplyTree(messageId: string): void {
    this.openPanel({ kind: 'replyTree', messageId });
  }

  /** メッセージの集合のパネルを開く（中身は timelinePanels の id で引く） */
  openTimeline(id: number): void {
    this.openPanel({ kind: 'timeline', id });
  }

  /** プラグインの view でセッションを開く。full: 主の場所をぜんぶ使う（registerView の layout: 'full'） */
  openPluginView(plugin: string, view: string, sessionId: string | null, full = false): void {
    this.openPanel({ kind: 'plugin', plugin, view, sessionId, ...(full ? { full: true } : {}) });
  }

  /** メッセージ検索を始める（メインチャットを見せる。モバイルでパネルが開いていれば閉じる） */
  openSearch(): void {
    this.navigate({ tab: 'chat', searchOpen: true, ...(this.isMobile ? { panel: null } : {}) });
    this.searchFocusTick++;
  }

  /** 検索を終えて通常の入力欄・タイムラインに戻る */
  closeSearch(): void {
    this.navigate({ searchOpen: false }, 'replace');
  }

  /**
   * ナビゲーションバーでタブを選ぶ。タブの切り替えは履歴を捨てる
   * （チャット以外のタブで戻ると、チャットのトップへ。Android のボトムナビと同じ）。closePanel ならパネルも閉じる
   */
  selectTab(tab: NavTab, closePanel = false): void {
    this.navigate({ tab, settingsSub: null, pluginSettings: null, ...(closePanel ? { panel: null } : {}) }, 'reset');
  }

  /** メインチャットを見せる（メッセージへの移動・共有の受け取りなど）。closePanel: パネルを閉じるか（mobile はモバイルのときだけ） */
  showMain(closePanel: 'mobile' | 'always' | 'never' = 'mobile'): void {
    const close = closePanel === 'always' || (closePanel === 'mobile' && this.isMobile);
    this.navigate({ tab: 'chat', ...(close ? { panel: null } : {}) });
  }

  /** 設定を開く（タブの切り替えと同じく履歴を捨てる）。設定を開いているときにもう一度押したら、サブページから一覧に戻る */
  openSettings(): void {
    this.navigate({ tab: 'settings', pluginSettings: null, settingsSub: null, ...(this.closesPanelOnTab() ? { panel: null } : {}) }, 'reset');
  }

  /**
   * 通話の画面が、いま見えているか（通話のタブで、エクスプローラーに覆われていない）。
   * タブが通話のままでも、エクスプローラーを開いていれば通話の画面は隠れる（Shell の shell-away）
   */
  get callScreenShown(): boolean {
    return this.tab === 'call' && !isFullPanel(this.panel);
  }

  /** タブを開くとき、いまのパネルを閉じるか。広い画面のほかのパネルは残す。エクスプローラーは通話・設定と場所を取り合うので閉じる */
  private closesPanelOnTab(): boolean {
    return !this.isMobile || isFullPanel(this.panel);
  }

  /**
   * 通話の画面（全画面版）を開く。モバイルではスレッドなどのパネルを閉じる。
   * 通話のバーなどから開いたときは、戻ると元の画面へ（push）。ナビゲーションバーのタブから開いたときは reset
   */
  openCall(mode: NavMode = 'push'): void {
    this.navigate({ tab: 'call', ...(this.isMobile || isFullPanel(this.panel) ? { panel: null } : {}) }, mode);
  }

  /** 設定の中で、プラグインの設定画面を開く */
  openPluginSettings(id: string): void {
    this.navigate({ tab: 'settings', settingsSub: null, pluginSettings: id });
  }

  closePluginSettings(): void {
    this.navigate({ pluginSettings: null }, 'replace');
  }

  /** 設定の中で、「操作」のサブページ（入力欄のキーなど）を開く。戻ると開いた元の画面（通話の画面など）へ */
  openSettingsSub(page: SettingsSubpage): void {
    this.navigate({ tab: 'settings', pluginSettings: null, settingsSub: page });
  }

  closeSettingsSub(): void {
    this.navigate({ settingsSub: null }, 'replace');
  }

  closePanel(): void {
    this.navigate({ panel: null }, 'replace');
  }

  /** パネルが無くなった（スレッドの削除・プラグインのセッションの終了など）。開いていれば閉じ、履歴からも外す */
  forgetPanel(match: (p: NonNullable<Panel>) => boolean): void {
    if (this.panel && match(this.panel)) this.closePanel();
    this.navStack = forgetPanelIn(this.navStack, match);
  }

  /** 拡大表示を開く。gallery を渡すと、前後の画像に移れる（一覧は移るたびに取り直す）。渡さなければ 1 枚だけ */
  openLightbox(item: LightboxItem, gallery: (() => LightboxItem[]) | null = null): void {
    this.shell.openLightbox(item, gallery);
  }

  /**
   * 戻る操作（Android の戻るボタン・PC の Alt+←・画面の「戻る」ボタン）。
   * 画像の全画面 → プラグインの層（新しい順）→ 遷移の履歴 の順に1つ戻す。戻る先がなければ false
   */
  back(): boolean {
    return this.shell.back(() => {
      const r = navBack(this.navStack, this.navState());
      if (!r) return false;
      this.navStack = r.stack;
      this.applyNav(r.to);
      return true;
    });
  }

  /** 戻る操作を何回できるか（Android の履歴の深さをこれに合わせる） */
  backDepth(): number {
    return this.shell.backDepth(navBackDepth(this.navStack, this.navState()));
  }

  /**
   * プラグインが登録した「戻る」で閉じるもの（`disnans.ui.onBack`。API v9）。戻る操作では、遷移の履歴よりも上に閉じる。返り値の関数で外す
   */
  addPluginBack(run: () => void): () => void {
    return this.shell.addPluginBack(run);
  }

  /** 通知を出して、その id を返す。ms が null なら自分では消えない（dismiss するまで。進行中の通知など） */
  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms: number | null = 5000, avatar?: ToastAvatar): number {
    return this.shell.toast(text, kind, action, ms, avatar);
  }

  dismiss(id: number): void {
    this.shell.dismiss(id);
  }

  confirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
    return this.shell.confirm(opts);
  }
}

export const ui = new Ui();
