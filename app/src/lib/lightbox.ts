// 写真の拡大表示（Lightbox）の、前後の画像をたどる決まり。画面の部品（components/Lightbox.svelte）は並べ替えと移動だけを使う。
// 画像の見分けは src（URL）。同じ画像が 2 回出るとき、前後は最初に出た位置から数える（既知の制限）

import type { Message } from './protocol/Message';
import { fileUrl } from './config';
import { attachmentRefs, bodyAttachmentNames, type AttachmentRef } from './fileLink';

/** 拡大表示の 1 件。kind: 'pdf' は PDF のページを並べて見る（前後の一覧には入れない）。無ければ画像 */
export type LightboxItem = { src: string; alt: string; downloadUrl: string; kind?: 'image' | 'pdf' };

/** 前後をたどる一覧。呼ぶたびに今の一覧を返す */
export type LightboxGallery = () => LightboxItem[];

/**
 * チャットの画像の一覧（表示の順）。メッセージの並び順（古い→新しい）、1 メッセージの中は本文での出現順、
 * そのあとに本文に無い添付の画像。本文の画像は bodyImage が決める（画像でなければ null）。
 * 削除された添付と、本文に入っている添付（本文の側で出る）は、ここでは数えない
 */
export function chatImageItems(messages: readonly Message[], bodyImage: (ref: AttachmentRef) => LightboxItem | null): LightboxItem[] {
  const out: LightboxItem[] = [];
  for (const m of messages) {
    for (const ref of attachmentRefs(m.body)) {
      const item = bodyImage(ref);
      if (item) out.push(item);
    }
    const linked = bodyAttachmentNames(m.body);
    for (const a of m.attachments) {
      if (a.deleted || linked.has(a.file_name.toLowerCase())) continue;
      if (!a.mime.startsWith('image/')) continue;
      const src = fileUrl(a.id);
      out.push({ src, alt: a.file_name, downloadUrl: src });
    }
  }
  return out;
}

/**
 * 前（delta < 0）・次（delta > 0）の画像。いまの画像が一覧に無い、または端で続きが無いときは null（動かさない）
 */
export function adjacentItem(items: readonly LightboxItem[], src: string, delta: -1 | 1): LightboxItem | null {
  const i = items.findIndex((it) => it.src === src);
  if (i < 0) return null;
  return items[i + delta] ?? null;
}
