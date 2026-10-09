import { getItem, setItem } from '../storage';

export type ThemePref = 'system' | 'light' | 'dark';

/** 右側のパネル（モバイルでは全画面）。将来プラグインの view もここに出す */
export type Panel = { kind: 'thread'; id: string } | null;

export type Toast = { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } };

export type ConfirmRequest = { title: string; body?: string; okLabel: string; danger?: boolean; resolve: (ok: boolean) => void };

const THEME_KEY = 'disnans.theme';
const MOBILE_QUERY = '(max-width: 767px)';

class Ui {
  theme = $state<ThemePref>((getItem(THEME_KEY) as ThemePref | null) ?? 'system');
  isMobile = $state(false);
  /** モバイルのボトムナビ */
  tab = $state<'chat' | 'threads'>('chat');
  panel = $state<Panel>(null);
  lightbox = $state<{ src: string; alt: string; downloadUrl: string } | null>(null);
  toasts = $state<Toast[]>([]);
  confirmReq = $state<ConfirmRequest | null>(null);
  profileOpen = $state(false);
  /** インライン編集中のメッセージ */
  editing = $state<string | null>(null);
  /** 相対時刻の表示を更新するための現在時刻 */
  now = $state(Date.now());
  private toastSeq = 0;

  init(): void {
    const mq = window.matchMedia(MOBILE_QUERY);
    this.isMobile = mq.matches;
    mq.addEventListener('change', (e) => (this.isMobile = e.matches));
    setInterval(() => (this.now = Date.now()), 30_000);
    this.applyTheme();
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
  }

  openThread(id: string): void {
    this.panel = { kind: 'thread', id };
  }

  closePanel(): void {
    this.panel = null;
  }

  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 5000): void {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, kind, action });
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
