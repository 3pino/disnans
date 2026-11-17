<script lang="ts">
  // 確認のダイアログ。見た目と答え方は土台（@3pino/app-kit-web/shell/ConfirmDialog.svelte）。ここは ui の要求を渡すだけ
  import ConfirmDialog from '@3pino/app-kit-web/shell/ConfirmDialog.svelte';
  import { ui } from '../lib/stores/ui.svelte';
</script>

<ConfirmDialog request={ui.confirmReq} />
