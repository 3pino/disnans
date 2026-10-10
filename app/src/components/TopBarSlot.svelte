<script lang="ts">
  import CallBar from './CallBar.svelte';
  import PluginStatusBar from './PluginStatusBar.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 画面上部の共通の枠。タブ（チャット・スレッド・設定）に関係なく、画面の一番上に出す。
  // 通話のバーと、プラグインのステータス欄（addStatusBarItem）がここに並ぶ。
  // 何も出ていないときは見えない（高さを取らない）
</script>

<div class="top-slot" role="region" aria-label="上部のバー">
  <!-- 通話の画面にいるときは、同じ内容がそこに出ているので上のバーは出さない -->
  {#if call.visible && ui.tab !== 'call'}<CallBar />{/if}
  <PluginStatusBar />
</div>

<style>
  .top-slot {
    flex: none;
    min-width: 0;
  }
  /* 中身があるときだけ、ステータスバー（Android の edge-to-edge）の分の余白を取る */
  .top-slot:has(:global(.call-bar, .plugin-status-item > :not(:empty))) {
    padding-top: env(safe-area-inset-top);
    background: var(--surface);
  }
</style>
