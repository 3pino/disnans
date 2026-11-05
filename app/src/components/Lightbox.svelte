<script lang="ts">
  import LightboxView from './LightboxView.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 写真・ファイルの拡大表示。表示そのもの（前後の切り替え・ビューアー・ツールバー・端末の安全域）は LightboxView が受け持ち、
  // ここは ui.lightbox（いま見ている 1 件）と一覧をつなぐだけ
</script>

<LightboxView item={ui.lightbox} gallery={ui.lightboxGallery} onchange={(i) => (ui.lightbox = i)} onclose={() => (ui.lightbox = null)} />
