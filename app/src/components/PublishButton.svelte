<script lang="ts">
  import Upload from '@lucide/svelte/icons/upload';
  import Users from '@lucide/svelte/icons/users';
  import Lock from '@lucide/svelte/icons/lock';
  import Button from './ui/Button.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import type { PluginVisibility } from '../lib/protocol/PluginVisibility';

  // [配布] ボタン。押すと「みんなに配布」「自分だけに配布」を選ぶメニューを出す（プラグイン・テーマの設定で使う）
  let {
    disabled = false,
    label = '配布',
    class: className = '',
    onpublish,
  }: {
    disabled?: boolean;
    label?: string;
    class?: string;
    onpublish: (visibility: PluginVisibility) => void;
  } = $props();

  let open = $state(false);

  function pick(v: PluginVisibility) {
    open = false;
    onpublish(v);
  }
</script>

<span class="publish-button {className}">
  <Button icon={Upload} {disabled} aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>{label}</Button>
  {#if open}
    <Menu class="publish-button-menu" label="配布の範囲" onclose={() => (open = false)}>
      <MenuItem class="publish-button-public" icon={Users} onclick={() => pick('public')}>
        <span class="publish-button-item">
          <span>みんなに配布</span>
          <span class="muted publish-button-detail">全員の端末で使えます</span>
        </span>
      </MenuItem>
      <MenuItem class="publish-button-private" icon={Lock} onclick={() => pick('private')}>
        <span class="publish-button-item">
          <span>自分だけに配布</span>
          <span class="muted publish-button-detail">自分の端末（スマホも）でだけ使えます</span>
        </span>
      </MenuItem>
    </Menu>
  {/if}
</span>

<style>
  .publish-button {
    position: relative;
    display: inline-flex;
  }
  .publish-button > :global(.publish-button-menu) {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    min-width: 240px;
  }
  .publish-button-item {
    display: flex;
    flex-direction: column;
    line-height: 1.35;
  }
  .publish-button-detail {
    font-size: 12px;
  }
</style>
