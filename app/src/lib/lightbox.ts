// チャットの画像の一覧（拡大表示で前後にたどる順）。拡大表示そのもの（部品・前後の決まり）は @3pino/viewer-kit-web/viewers

import type { Message } from './protocol/Message';
import { fileUrl } from './config';
import { attachmentRefs, bodyAttachmentNames, type AttachmentRef } from './fileLink';

// 拡大表示の型と前後の決まりは @3pino/viewer-kit-web/viewers（types）。ここは disnans のチャットの一覧だけ
export type { LightboxItem, LightboxGallery } from '@3pino/viewer-kit-web/viewers/types';
export { adjacentItem } from '@3pino/viewer-kit-web/viewers/types';
import type { LightboxItem } from '@3pino/viewer-kit-web/viewers/types';

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
