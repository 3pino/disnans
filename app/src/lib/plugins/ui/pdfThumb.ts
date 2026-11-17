// disnans.ui.renderPdfThumb: 本体の PdfThumb（PDF の 1 ページ目のサムネイル）を、プラグインの要素の中へ mount する。
// Svelte の部品は本体の実行環境の中で mount する（プラグインは要素だけ受け取る）。外すと unmount して、要素を空にする。

import { mount, unmount, untrack } from 'svelte';
import PdfThumb from '../../../components/PdfThumb.svelte';

export function mountPdfThumb(el: HTMLElement, url: string, key: string): () => void {
  const app = untrack(() => mount(PdfThumb, { target: el, props: { url, key } }));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void unmount(app);
  };
}
