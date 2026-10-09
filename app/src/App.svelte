<script lang="ts">
  import { onMount } from 'svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toasts from './components/Toasts.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import { needsServerSetup, isAndroid, isTauri } from './lib/config';
  import { client } from './lib/stores/client.svelte';
  import { ui } from './lib/stores/ui.svelte';
  import { notifications } from './lib/stores/notifications.svelte';

  let setup = $state(needsServerSetup());

  ui.init();

  $effect(() => {
    if (setup) return;
    client.start();
    void notifications.init();
  });

  // 配布版でも Ctrl+Shift+I で開発者ツールを開く（デスクトップのみ）
  onMount(() => {
    if (!isTauri() || isAndroid()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
        e.preventDefault();
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_devtools'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
