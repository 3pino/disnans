// アプリの土台の状態（トースト・確認・拡大表示・戻る操作の層）。
// チャット・通話・設定・サーバーのことは知らない。送り主の表示（アバター）・拡大表示の画像の型は引数で決める。
// 遷移の履歴（タブ・パネルなど）は持たない。戻る操作のうち遷移の部分は、呼び出し側が back() に渡す。
// 共有パッケージへ出すときは、このファイルとテストをそのまま持っていける（import は無し）。

/** 通知 1 件。avatar は呼び出し側の型（本体では送り主のアイコン） */
export type ShellToast<A = unknown> = {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
  avatar?: A;
};

export type ShellConfirm = {
  title: string;
  body?: string;
  okLabel: string;
  /** 取り消すボタンの文字（省くと「キャンセル」） */
  ngLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
};

export class Shell<A = unknown, I = unknown> {
  toasts = $state<ShellToast<A>[]>([]);
  confirmReq = $state<ShellConfirm | null>(null);
  /** 拡大表示の画像（いま見ている 1 枚）。開くのは openLightbox で */
  lightbox = $state<I | null>(null);
  /** 拡大表示の前後をたどる一覧（呼ぶたびに今の一覧を返す）。ないときは前後に移れない */
  lightboxGallery = $state<(() => I[]) | null>(null);
  // raw: 中身を包む（proxy にする）と、外すときの e !== entry が常に真になり外れない。いつも配列ごと入れ替える
  pluginBack = $state.raw<{ run: () => void }[]>([]);
  private toastSeq = 0;

  /** 通知を出して、その id を返す。ms が null なら自分では消えない（dismiss するまで） */
  toast(text: string, kind: ShellToast['kind'] = 'info', action?: ShellToast['action'], ms: number | null = 5000, avatar?: A): number {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, kind, action, avatar });
    if (ms !== null) setTimeout(() => this.dismiss(id), ms);
    return id;
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  confirm(opts: Omit<ShellConfirm, 'resolve'>): Promise<boolean> {
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

  /** 拡大表示を開く。gallery を渡すと、前後の画像に移れる（一覧は移るたびに取り直す）。渡さなければ 1 枚だけ */
  openLightbox(item: I, gallery: (() => I[]) | null = null): void {
    this.lightboxGallery = gallery;
    this.lightbox = item;
  }

  /** プラグインが登録した「戻る」で閉じるもの。古い順。戻る操作では、遷移の履歴よりも上（先）に閉じる。返り値の関数で外す */
  addPluginBack(run: () => void): () => void {
    const entry = { run };
    this.pluginBack = [...this.pluginBack, entry];
    return () => {
      this.pluginBack = this.pluginBack.filter((e) => e !== entry);
    };
  }

  /**
   * 戻る操作（Android の戻るボタン・PC の Alt+←・画面の「戻る」ボタン）。
   * 画像の全画面 → プラグインの層（新しい順）→ nav（呼び出し側の遷移の履歴）の順に 1 つ戻す。戻る先がなければ false
   */
  back(nav: () => boolean): boolean {
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
    return nav();
  }

  /** 戻る操作を何回できるか。navDepth は呼び出し側の遷移の履歴の深さ */
  backDepth(navDepth: number): number {
    return (this.lightbox ? 1 : 0) + this.pluginBack.length + navDepth;
  }
}
