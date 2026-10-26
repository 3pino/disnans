// チャットのタイムラインの画像の一覧（Lightbox の前後）。読み込み済みのメッセージだけを対象にする。開くたびでなく、移動のたびに今の一覧を取る
import { client } from './stores/client.svelte';
import { sharedIndex } from './stores/sharedIndex.svelte';
import { deletedAttachmentNames, fileLinkView } from './fileLink';
import { chatImageItems, type LightboxItem } from './lightbox';

/** チャットに読み込み済みの画像（本文の画像リンク・埋め込み、本文に無い添付の画像）。画像でないもの（ファイル・PDF・フォルダ）は除く */
export function chatGallery(): LightboxItem[] {
  const messages = client.timeline().messages;
  const deleted = deletedAttachmentNames(messages);
  return chatImageItems(messages, (ref) => {
    const path = `attachments/${ref.name}`;
    const view = fileLinkView({ path, alias: ref.alias, embed: ref.embed }, sharedIndex.file(path), deleted);
    // 開くときの FileLink と同じ値（src・alt）を使う
    if (view.kind === 'image') return { src: view.src, alt: view.alt, downloadUrl: view.src };
    if (view.kind === 'embedImage') return { src: view.src, alt: view.alt, downloadUrl: view.src };
    return null;
  });
}
