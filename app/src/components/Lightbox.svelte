<script lang="ts">
  import LightboxView from '@3pino/viewer-kit-web/viewers/LightboxView.svelte';
  import { defaultViewers } from '@3pino/viewer-kit-web/viewers';
  import { interceptDownload } from '../lib/download';
  import { attachmentActionText } from '../lib/fileLink';
  import { ui } from '../lib/stores/ui.svelte';

  // 写真・ファイルの拡大表示。表示そのもの（前後の切り替え・ビューアー・ツールバー・端末の安全域）は土台（@3pino/viewer-kit-web）が受け持ち、
  // ここは ui.lightbox（いま見ている 1 件）と一覧をつなぎ、保存（Tauri では直接）と読めなかったときの文を disnans のものにする
</script>

<LightboxView
  item={ui.lightbox}
  gallery={ui.lightboxGallery}
  viewers={defaultViewers}
  ondownload={(ev, item) => interceptDownload(ev, { url: item.downloadUrl, name: item.alt })}
  errorText={attachmentActionText}
  onchange={(i) => (ui.lightbox = i)}
  onclose={() => (ui.lightbox = null)}
/>
