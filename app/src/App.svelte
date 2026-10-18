<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Setup from './components/Setup.svelte';
  import Shell from './components/Shell.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import Toasts from './components/Toasts.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import { applyServerUrl, needsServerSetup, getServerUrl } from './lib/config';
  import { isAndroid, isTauri } from './lib/platform';
  import { didInitializeWithLegacyFallback, getDesktopSharedStorage, initializeDesktopStorage, isDesktopStorageSupported } from './lib/desktopStorage';
  import { flushDraftSaves } from './lib/drafts';
  import { isMac } from './lib/plugins/hotkey';
  import { startViewportSync, startZoomGuard } from './lib/viewport';
  import { client } from './lib/stores/client.svelte';
  import { ui } from './lib/stores/ui.svelte';
  import { notifications } from './lib/stores/notifications.svelte';
  import { startShareReceiver } from './lib/share';
  import { pluginHost } from './lib/plugins/host.svelte';
  import { isBackKey, startBackNav } from './lib/backNav';
  import { startDropGuard } from './lib/dropGuard';
  import { startContextMenuGuard } from './lib/contextMenu';
  import { startUpdateWatch } from './lib/updateWatch';

  const desktopStorageEnabled = isDesktopStorageSupported();
  let bootReady = $state(!desktopStorageEnabled);
  let setup = $state(desktopStorageEnabled || needsServerSetup());

  ui.init();

  $effect(() => {
    if (!bootReady || setup) return;
    client.start();
    pluginHost.start();
    void notifications.init();
    void startShareReceiver();
  });

  onMount(() => {
    if (!desktopStorageEnabled) return;
    void initializeDesktopStorage().then((serverUrl) => {
      applyServerUrl(serverUrl);
      if (didInitializeWithLegacyFallback()) {
        ui.toast('共有ストレージを読み込めません。端末内の設定で起動しました。接続先や下書きの変更は他のクライアントへ共有されません。', 'error', undefined, 12_000);
      }
    }).catch((error) => {
      console.error('共有ストレージを初期化できませんでした', error);
      ui.toast('共有ストレージを初期化できません。端末内の設定で起動しました。接続先や下書きの変更は他のクライアントへ共有されません。', 'error', undefined, 12_000);
      // IPC未統合/障害時は既存localStorage設定で起動する（保存結果は各hostで通知）。
      applyServerUrl(getServerUrl());
    }).finally(() => {
      setup = needsServerSetup();
      bootReady = true;
    });
  });

  // 別のdesktop clientが接続先を変えた場合、確認なしに通信先を切り替えない。
  onMount(() => {
    if (!desktopStorageEnabled) return;
    let promptedServer: string | undefined;
    const refreshSharedServer = async () => {
      if (!bootReady) return;
      const shared = getDesktopSharedStorage();
      if (!shared) return;
      let next: string | null;
      try {
        next = await shared.getServer();
      } catch {
        return;
      }
      const activeServer = getServerUrl() || null;
      if (next === activeServer) {
        promptedServer = undefined;
        return;
      }
      const promptKey = next ?? '';
      if (promptKey === promptedServer) return;
      promptedServer = promptKey;
      window.setTimeout(() => {
        if (promptedServer === promptKey) promptedServer = undefined;
      }, 60_000);
      const destination = next ? `「${next}」` : '未設定';
      ui.toast(
        `別のクライアントで接続先が${destination}に変更されました。入力中の文章は保存後に再読み込みしてください。`,
        'info',
        {
          label: '保存して再読み込み',
          run: () => {
            void (async () => {
              try {
                await flushDraftSaves();
                location.reload();
              } catch (error) {
                promptedServer = undefined;
                ui.toast(`入力中の文章や添付を保護できないため再読み込みしませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error');
              }
            })();
          },
        },
        60_000,
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshSharedServer();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
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

  // PC の Alt+←: Android の戻るボタンと同じく、遷移の履歴を1つ戻る（ui.back。Android では戻るボタンを使う）
  onMount(() => {
    if (isAndroid()) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBackKey(e)) return;
      // Mac の Option+← は入力欄で単語の移動に使うので、入力欄の中では効かせない
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
      if (isMac() && typing) return;
      e.preventDefault();
      ui.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ファイルをどこに落としても、WebView がファイルへ移動しない（受け取りは ChatView が行う）
  onMount(() => startDropGuard());

  // 右クリックの WebView の既定のメニュー（更新・保存・印刷など）は出さない。入力欄の中は残す（アプリの独自の右クリックはそのまま動く）
  onMount(() => startContextMenuGuard());

  // アプリのアップデートを裏で確認し、新しい版があれば知らせる（Tauri 版だけ）
  onMount(() => startUpdateWatch());

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

  // 戻る操作（Android の戻るボタン）で、遷移の履歴を1つずつ戻る（画像の全画面 → プラグインの層 → 来た画面。lib/navHistory.ts）。
  // チャットのトップで何も開いていなければ、履歴が尽きてアプリが裏に回る。モバイルの表示か Android のときだけ使う
  $effect(() => {
    if (!ui.isMobile && !isAndroid()) return;
    const nav = startBackNav({ depth: () => ui.backDepth(), back: () => ui.back() });
    $effect(() => {
      void ui.backDepth();
      untrack(() => nav.sync());
    });
    return () => nav.stop();
  });

  // 設定のタブを離れたら、プラグインの設定画面と設定のサブページは閉じる
  $effect(() => {
    if (ui.tab === 'settings') return;
    if (ui.pluginSettings) ui.closePluginSettings();
    if (ui.settingsSub) ui.closeSettingsSub();
  });
</script>

{#if !bootReady}
  <!-- Shared desktop server settings must resolve before Setup or client startup. -->
{:else if setup}
  <Setup ondone={() => (setup = false)} />
{:else}
  <Shell />
  <ConfirmDialog />
  <Lightbox />
{/if}
<Toasts />
