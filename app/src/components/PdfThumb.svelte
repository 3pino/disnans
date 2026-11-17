<script lang="ts">
  // 実体は @3pino/viewer-kit-web（PDF のサムネイル）。ここは、このパスを読むもの（explorer の試験）のための薄い入口
  import PdfThumb from '@3pino/viewer-kit-web/viewers/PdfThumb.svelte';

  let { url, key }: { url: string; key: string } = $props();
</script>

<PdfThumb {url} {key} />
