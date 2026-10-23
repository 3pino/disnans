// 入力欄の添付（アップロード中・できた・失敗）。選んだらすぐ上げ、できたら本文に `![[attachments/名前]]` を入れる。
// 送信は本文だけ（添付は本文のリンクで決まる）。本文から埋め込みを消した添付は、送らずに消す。
// 入力欄・通信・画像の読み込みは依存として渡す（テストで差し替える）。

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
  /** 本文に入れた埋め込み（ready のとき） */
  embed: string | null;
  error: string | null;
};

export type UploadHandle = { promise: Promise<Attachment>; abort: () => void };

export type AttachDeps = {
  /** 送る前の加工（切り抜き）。crop が null なら元のまま */
  prepare: (file: File, crop: CropRect | null) => Promise<File>;
  /** アップロード（進みと中止つき） */
  upload: (file: File, onProgress: (ratio: number) => void) => UploadHandle;
  /** 投稿されていない添付を消す（失敗しても黙って進める） */
  remove: (att: Attachment) => Promise<void>;
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
};

export class ComposerAttachments {
  items = $state<StagedItem[]>([]);
  private seq = 0;

  constructor(private deps: AttachDeps) {}

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

  /** 取り消す。アップロード中なら中止し、本文の埋め込みを外し、できた添付は消す */
  cancel(key: number): void {
    const s = this.find(key);
    if (!s) return;
    this.abort(s);
    if (s.embed) this.deps.unembed(s.embed);
    if (s.attachment) void this.deps.remove(s.attachment);
    if (s.preview) this.deps.revoke(s.preview);
    this.items = this.items.filter((x) => x.key !== key);
  }

  /** 切り抜きを決めた。送れたあとなら、上げ直して本文の埋め込みを入れ替える */
  recrop(key: number, crop: CropRect | null): void {
    const s = this.find(key);
    if (!s) return;
    s.crop = crop;
    if (s.status === 'ready' && s.attachment && s.embed) {
      this.start(key, { embed: s.embed, attachment: s.attachment });
    }
  }

  /**
   * 送信のあと: 本文に残った添付は、そのまま送られる。残らなかった（埋め込みを消した）添付は消す。
   * 一覧はすべて空にする（アップロード中のものは、呼ぶ前に確かめておく）
   */
  settle(body: string): void {
    for (const s of this.items) {
      if (s.status === 'ready' && s.attachment && !(s.embed && body.includes(s.embed))) void this.deps.remove(s.attachment);
      if (s.preview) this.deps.revoke(s.preview);
    }
    this.items = [];
  }

  /** 画面を閉じる: 途中のアップロードは中止する（できたものは、本文の埋め込みに残るので消さない） */
  dispose(): void {
    for (const s of this.items) this.abort(s);
  }

  private abort(s: StagedItem): void {
    // 中止は、ここで保持している中止の関数で行う
    this.aborts.get(s.key)?.();
    this.aborts.delete(s.key);
  }

  private aborts = new Map<number, () => void>();

  /** アップロードを始める（できたら本文に埋め込む）。replacing があれば、その埋め込みを新しいものに入れ替える */
  private start(key: number, replacing?: { embed: string; attachment: Attachment }): void {
    const first = this.find(key);
    if (!first) return;
    first.status = 'uploading';
    first.progress = 0;
    first.error = null;
    void (async () => {
      try {
        const file = await this.deps.prepare(first.file, first.crop);
        if (!this.find(key)) return; // 取り消された
        const h = this.deps.upload(file, (r) => {
          const c = this.find(key);
          if (c) c.progress = r;
        });
        this.aborts.set(key, h.abort);
        const att = await h.promise;
        this.aborts.delete(key);
        const done = this.find(key);
        if (!done) {
          // 取り消したあとにできたものは、本文に入らないので消す
          void this.deps.remove(att);
          return;
        }
        const embed = embedFor(att.file_name);
        const placed = replacing ? this.deps.replace(replacing.embed, embed) : this.deps.insert(embed);
        if (!placed) {
          // 入力欄が無い、または切り抜きの途中で埋め込みを消された。新しいものは入れずに消す
          this.cancel(key);
          void this.deps.remove(att);
          return;
        }
        done.attachment = att;
        done.embed = embed;
        done.status = 'ready';
        done.progress = 1;
        if (replacing) void this.deps.remove(replacing.attachment);
      } catch (e) {
        this.aborts.delete(key);
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
