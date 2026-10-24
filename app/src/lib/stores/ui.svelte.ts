import type { AuthorView } from '../author';
import { setNavigationBarHidden, syncSystemBars } from '../systemBars';
import { prefs } from './prefs.svelte';
import { deviceSettings } from './deviceSettings.svelte';
import { setSettingsErrorHandler } from '../settingsModel';
import type { User } from '../protocol/User';
import { forgetPanelIn, navBack, navBackDepth, navigate, normalizeNav, type NavMode, type NavState, type NavTab, type Panel, type SettingsSubpage } from '../navHistory';

export type ThemePref = 'system' | 'light' | 'dark';

export type { Panel, SettingsSubpage, NavTab, NavState, NavMode } from '../navHistory';

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

const MOBILE_QUERY = '(max-width: 767px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';

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

  /** 共有フォルダの中身を見るパネルを開く */
  openFiles(): void {
    this.openPanel({ kind: 'files' });
  }

  /** プラグインの view でセッションを開く */
  openPluginView(plugin: string, view: string, sessionId: string): void {
    this.openPanel({ kind: 'plugin', plugin, view, sessionId });
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
    return this.tab === 'call' && this.panel?.kind !== 'files';
  }

  /** タブを開くとき、いまのパネルを閉じるか。広い画面のほかのパネルは残す。エクスプローラーは通話・設定と場所を取り合うので閉じる */
  private closesPanelOnTab(): boolean {
    return !this.isMobile || this.panel?.kind === 'files';
  }

  /**
   * 通話の画面（全画面版）を開く。モバイルではスレッドなどのパネルを閉じる。
   * 通話のバーなどから開いたときは、戻ると元の画面へ（push）。ナビゲーションバーのタブから開いたときは reset
   */
  openCall(mode: NavMode = 'push'): void {
    this.navigate({ tab: 'call', ...(this.isMobile || this.panel?.kind === 'files' ? { panel: null } : {}) }, mode);
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

  /**
   * 戻る操作（Android の戻るボタン・PC の Alt+←・画面の「戻る」ボタン）。
   * 画像の全画面 → プラグインの層（新しい順）→ 遷移の履歴 の順に1つ戻す。戻る先がなければ false
   */
  back(): boolean {
    if (this.lightbox) {
      this.lightbox = null;
      return true;
    }
    const top = this.pluginBack.at(-1);
    if (top) {
      // 先に外す（プラグインが外し忘れても、戻る操作が空回りしないように）
      this.pluginBack = this.pluginBack.slice(0, -1);
      try {
        top.run();
      } catch (e) {
        console.error('プラグインの戻る操作で例外', e);
      }
      return true;
    }
    const r = navBack(this.navStack, this.navState());
    if (!r) return false;
    this.navStack = r.stack;
    this.applyNav(r.to);
    return true;
  }

  /** 戻る操作を何回できるか（Android の履歴の深さをこれに合わせる） */
  backDepth(): number {
    return (this.lightbox ? 1 : 0) + this.pluginBack.length + navBackDepth(this.navStack, this.navState());
  }

  /**
   * プラグインが登録した「戻る」で閉じるもの（`disnans.ui.onBack`。API v9）。古い順。
   * 戻る操作では、遷移の履歴よりも上（先）に閉じる（back）。返り値の関数で外す
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
