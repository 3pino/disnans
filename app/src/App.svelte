<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toasts from './components/Toasts.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import { needsServerSetup, isAndroid, isTauri } from './lib/config';
  import { isMac } from './lib/plugins/hotkey';
  import { startViewportSync, startZoomGuard } from './lib/viewport';
  import { client } from './lib/stores/client.svelte';
  import { ui } from './lib/stores/ui.svelte';
  import { notifications } from './lib/stores/notifications.svelte';
  import { startShareReceiver } from './lib/share';
  import { pluginHost } from './lib/plugins/host.svelte';
  import { closeTopLayer, isBackKey, startBackNav } from './lib/backNav';

  let setup = $state(needsServerSetup());

  ui.init();

  $effect(() => {
    if (setup) return;
    client.start();
    pluginHost.start();
    void notifications.init();
    void startShareReceiver();
  });

  // キーボードを出したときも、アプリの高さを見えている高さに合わせる。拡大（ピンチ・Ctrl+ホイールなど）は止める
  onMount(() => {
    const stopViewport = startViewportSync();
    const stopZoom = startZoomGuard();
    return () => {
      stopViewport();
      stopZoom();
    };
  });

  // PC の Alt+←: Android の戻るボタンと同じく、開いているものを上から1つずつ閉じる（Android では戻るボタンを使う）
  onMount(() => {
    if (isAndroid()) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBackKey(e)) return;
      // Mac の Option+← は入力欄で単語の移動に使うので、入力欄の中では効かせない
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
      if (isMac() && typing) return;
      e.preventDefault();
      closeTopLayer(ui.backLayers());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  // 戻る操作（Android の戻るボタン）で、パネル → プラグインの設定画面 → チャット以外のタブ の順に閉じる。
  // チャットで何も開いていなければ、履歴が尽きてアプリが裏に回る。モバイルの表示か Android のときだけ使う
  $effect(() => {
    if (!ui.isMobile && !isAndroid()) return;
    const nav = startBackNav(() => ui.backLayers());
    $effect(() => {
      void ui.backLayers().length;
      untrack(() => nav.sync());
    });
    return () => nav.stop();
  });

  // 設定のタブを離れたら、プラグインの設定画面は閉じる
  $effect(() => {
    if (ui.tab !== 'settings' && ui.pluginSettings) ui.closePluginSettings();
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
