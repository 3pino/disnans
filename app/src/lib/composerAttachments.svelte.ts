// 入力欄の添付（アップロード中・できた・失敗）。選んだらすぐ上げ、できたら本文に `![[attachments/名前]]` を入れる。
// 送信は本文だけ（添付は本文のリンクで決まる）。
// 未投稿の添付を消す（DELETE /api/files/{id}。投稿前のものだけ消せる）のは、次のとき:
// - 取り消した（×）: すぐ。
// - 本文から埋め込みを消した: すぐには消さない。ORPHAN_GRACE_MS のあいだに本文へ戻ったら（Ctrl+Z など）残す。
//   戻らなければ、その時刻に消す。送信・入力欄を空にする・画面を閉じる/切り替えるときは、待たずに消す。
// 送ったもの（埋め込みが本文に残っていたもの）は一覧から外すだけ（投稿されたので消さない）。
// 接続先・利用者が変わったら、一覧を捨てる（消さない: 消す先の接続が変わっているため）。
// 入力欄・通信・画像の読み込みは依存として渡す（テストで差し替える）。

/** 本文から消された埋め込みを、未投稿の添付として消すまでの猶予（ミリ秒）。Ctrl+Z などで戻せる時間 */
export const ORPHAN_GRACE_MS = 60_000;

import type { Attachment } from './protocol/Attachment';
import type { CropRect, ImageInfo } from './imageCrop';
import { embedFor } from './composerAttach';

/** 添付の 1 つ */
export type StagedItem = {
  key: number;
  file: File;
  preview: string | null;
  /** 寸法など（画像のときだけ。読めなければ null） */
  info: ImageInfo | null;
  /** 送る前に切り抜く範囲（null は全体） */
  crop: CropRect | null;
  status: 'uploading' | 'ready' | 'failed';
  /** アップロードの進み（0〜1） */
  progress: number;
  /** できた添付（ready のとき） */
  attachment: Attachment | null;
  /** 本文に入れた埋め込み（ready のとき。入れ替え・取り消しの途中は null） */
  embed: string | null;
  error: string | null;
};

export type UploadHandle = { promise: Promise<Attachment>; abort: () => void };

export type AttachDeps = {
  /** 送る前の加工（切り抜き）。crop が null なら元のまま */
  prepare: (file: File, crop: CropRect | null) => Promise<File>;
  /** アップロード（進みと中止つき） */
  upload: (file: File, onProgress: (ratio: number) => void) => UploadHandle;
  /** 投稿前の添付を取り消す（DELETE）。失敗は黙って進める（呼ぶ側で記録する） */
  discard: (att: Attachment) => Promise<void>;
  /** 自分が上げた投稿前の添付の印（本文の表示に使う）。on が false で外す */
  mark: (att: Attachment, on: boolean) => void;
  /** キャレットの位置に埋め込みを入れる。入力欄が無ければ false */
  insert: (embed: string) => boolean;
  /** 本文の中の埋め込みを置き換える。見つからなければ false */
  replace: (from: string, to: string) => boolean;
  /** 本文の中の埋め込みを外す */
  unembed: (embed: string) => void;
  /** 画像の寸法（読めなければ null） */
  readInfo: (file: File) => Promise<ImageInfo | null>;
  /** 一覧用の見本（画像のみ）。破棄は revoke */
  preview: (file: File) => string | null;
  revoke: (url: string) => void;
  toast: (text: string) => void;
  /** 猶予の計時（省略時は setTimeout）。テストで進める */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
};

export class ComposerAttachments {
  items = $state<StagedItem[]>([]);
  private seq = 0;
  /** 接続先・利用者の世代。変わったあとに終わった通信は、結果を入れない */
  private gen = 0;
  private aborts = new Map<number, () => void>();
  /** 本文から消された埋め込みの、消す時刻までのタイマー（キーは項目） */
  private orphans = new Map<number, unknown>();
  private timers: NonNullable<AttachDeps['timers']>;
  /** いまの本文（最後に知らせてもらったもの） */
  private body = '';

  constructor(private deps: AttachDeps) {
    this.timers = deps.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  /** アップロードの途中がある（終わるまで送らない） */
  get uploading(): boolean {
    return this.items.some((s) => s.status === 'uploading');
  }

  find(key: number): StagedItem | undefined {
    return this.items.find((x) => x.key === key);
  }

  /** 添付に加える。すぐアップロードする */
  add(files: File[]): void {
    for (const file of files) {
      const key = ++this.seq;
      this.items.push({
        key,
        file,
        preview: this.deps.preview(file),
        info: null,
        crop: null,
        status: 'uploading',
        progress: 0,
        attachment: null,
        embed: null,
        error: null,
      });
      void this.deps.readInfo(file).then((info) => {
        const s = this.find(key);
        if (s) s.info = info;
      });
      this.start(key);
    }
  }

  /** 失敗したものを、もう一度上げる */
  retry(key: number): void {
    if (this.find(key)?.status === 'failed') this.start(key);
  }

  /** 取り消す（×）。アップロード中なら中止し、本文の埋め込みを外し、できた添付はすぐ消す（投稿前だけ消せる） */
  cancel(key: number): void {
    const s = this.find(key);
    if (!s) return;
    this.abort(s);
    const embed = s.embed;
    // 先に外す（入力欄の更新で sync が呼ばれても、この項目は対象外になる）
    s.embed = null;
    if (embed) this.deps.unembed(embed);
    this.purge(s);
  }

  /**
   * 入力欄の本文が変わったとき。埋め込みが本文に無くなった添付は、猶予のあとで消す（戻ればそのまま残す）。
   * 入れ替え中・アップロード中のものは対象外
   */
  sync(body: string): void {
    this.body = body;
    for (const s of this.items) {
      if (s.status !== 'ready' || !s.embed) continue;
      if (body.includes(s.embed)) {
        this.clearOrphan(s.key);
      } else if (!this.orphans.has(s.key)) {
        this.orphans.set(
          s.key,
          this.timers.set(() => {
            this.orphans.delete(s.key);
            const c = this.find(s.key);
            if (c && c.status === 'ready' && c.embed && !this.body.includes(c.embed)) this.purge(c);
          }, ORPHAN_GRACE_MS),
        );
      }
    }
  }

  /**
   * 本文を空にした（送らずに消した: 下書きの破棄）。本文に無い添付は、待たずに消す。
   * 送信・画面を閉じるときも、同じく本文に無いものを消す
   */
  dropUnsent(body: string): void {
    this.body = body;
    for (const s of [...this.items]) {
      if (s.status === 'ready' && s.embed && !body.includes(s.embed)) this.purge(s);
    }
  }

  /** 切り抜きを決めた。送る前のものなら、上げ直して埋め込みを入れ替える */
  recrop(key: number, crop: CropRect | null): void {
    const s = this.find(key);
    if (!s) return;
    s.crop = crop;
    if (s.status === 'ready' && s.attachment && s.embed) {
      this.start(key, { embed: s.embed, attachment: s.attachment });
    }
  }

  /**
   * 送ったあと: 埋め込みが送った本文に残っているものは、一覧から外す（投稿されたので消さない）。
   * 残っていないもの（失敗・途中）は、そのまま残す
   */
  settle(body: string): void {
    this.body = body;
    for (const s of [...this.items]) {
      if (s.status !== 'ready' || !s.embed) continue;
      if (body.includes(s.embed)) {
        // 送られた（投稿されたので消さない）: 一覧から外すだけ
        this.clearOrphan(s.key);
        if (s.preview) this.deps.revoke(s.preview);
        this.items = this.items.filter((x) => x.key !== s.key);
      } else {
        // 本文から消されていた（送らない）: 待たずに消す
        this.purge(s);
      }
    }
  }

  /**
   * 接続先・利用者が変わった: 一覧を捨てる。途中の通信は中止し、終わったものは入れない。
   * 消す（DELETE）はしない（消す先の接続が変わっているため。古いものは掃除で消える）
   */
  forget(): void {
    this.gen++;
    for (const s of this.items) {
      this.abort(s);
      this.clearOrphan(s.key);
      if (s.preview) this.deps.revoke(s.preview);
    }
    this.items = [];
    this.body = '';
  }

  /**
   * 画面を閉じる: 途中のアップロードは中止する。本文に無い添付は消す（残っている埋め込みは下書きに残るので消さない）。
   * 猶予のタイマーも止める
   */
  dispose(): void {
    for (const s of this.items) this.abort(s);
    this.dropUnsent(this.body);
    for (const key of [...this.orphans.keys()]) this.clearOrphan(key);
  }

  /** 項目を一覧から外し、未投稿の添付なら消す（DELETE）。消せなくても、24 時間後には掃除で消える */
  private purge(s: StagedItem): void {
    this.clearOrphan(s.key);
    this.abort(s);
    if (s.attachment) {
      this.deps.mark(s.attachment, false);
      void this.deps.discard(s.attachment);
    }
    if (s.preview) this.deps.revoke(s.preview);
    this.items = this.items.filter((x) => x.key !== s.key);
  }

  private clearOrphan(key: number): void {
    const t = this.orphans.get(key);
    if (t !== undefined) this.timers.clear(t);
    this.orphans.delete(key);
  }

  private abort(s: StagedItem): void {
    this.aborts.get(s.key)?.();
    this.aborts.delete(s.key);
  }

  /** アップロードを始める（できたら本文に埋め込む）。replacing があれば、その埋め込みを新しいものに入れ替える */
  private start(key: number, replacing?: { embed: string; attachment: Attachment }): void {
    const first = this.find(key);
    if (!first) return;
    const g = this.gen;
    first.status = 'uploading';
    first.progress = 0;
    first.error = null;
    void (async () => {
      try {
        const file = await this.deps.prepare(first.file, first.crop);
        if (g !== this.gen || !this.find(key)) return; // 取り消された・接続先が変わった
        const h = this.deps.upload(file, (r) => {
          const c = this.find(key);
          if (c) c.progress = r;
        });
        this.aborts.set(key, h.abort);
        const att = await h.promise;
        this.aborts.delete(key);
        if (g !== this.gen) return; // 接続先が変わったあとにできたもの（入れない）
        const done = this.find(key);
        if (!done) {
          // 取り消したあとにできたものは、本文に入らないので取り消す
          void this.deps.discard(att);
          return;
        }
        const embed = embedFor(att.file_name);
        // 入れ替え・挿入の途中は、sync の対象にしない
        done.embed = null;
        let placed = false;
        if (replacing) placed = this.deps.replace(replacing.embed, embed);
        else placed = this.deps.insert(embed);
        if (!placed) {
          // 入力欄が無い、または切り抜きの途中で埋め込みを消された。新しいものは入れずに取り消す
          this.cancel(key);
          void this.deps.discard(att);
          return;
        }
        done.attachment = att;
        done.embed = embed;
        done.status = 'ready';
        done.progress = 1;
        this.deps.mark(att, true);
        if (replacing) {
          this.deps.mark(replacing.attachment, false);
          void this.deps.discard(replacing.attachment);
        }
      } catch (e) {
        this.aborts.delete(key);
        if (g !== this.gen) return;
        const c = this.find(key);
        if (!c) return; // 取り消したときの中止は、失敗として扱わない
        const message = e instanceof Error ? e.message : String(e);
        if (replacing) {
          // 切り抜きのやり直しが失敗したら、前のもの（本文の埋め込み）は残す
          c.status = 'ready';
          this.deps.toast(`切り抜いた画像を送れませんでした: ${message}`);
        } else {
          c.status = 'failed';
          c.error = message;
        }
      }
    })();
  }
}
