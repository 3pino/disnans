<script lang="ts">
  import { onMount } from 'svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toasts from './components/Toasts.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import { needsServerSetup, isTauri } from './lib/config';
  import { client } from './lib/stores/client.svelte';
  import { ui } from './lib/stores/ui.svelte';

  let setup = $state(needsServerSetup());

  ui.init();

  $effect(() => {
    if (!setup) client.start();
  });

  onMount(() => {
    // Tauri では外部リンクを既定のブラウザーで開く
    if (!isTauri()) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !/^https?:/i.test(a.href) || a.origin === location.origin) return;
      e.preventDefault();
      void import('@tauri-apps/plugin-opener').then((m) => m.openUrl(a.href));
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  });

  // モバイルで戻る操作（Android の戻るボタン）でパネルを閉じる
  $effect(() => {
    if (!ui.panel || !ui.isMobile) return;
    history.pushState({ panel: true }, '');
    const onPop = () => ui.closePanel();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (history.state?.panel) history.back();
    };
  });
</script>

{#if setup}
  <Setup ondone={() => (setup = false)} />
{:else}
  <Shell />
  <ConfirmDialog />
  <Lightbox />
{/if}
<Toasts />
