<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minimize from '@lucide/svelte/icons/minimize';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture';
  import IconButton from './ui/IconButton.svelte';
  import LightboxView from './LightboxView.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { isAndroid } from '../lib/platform';
  import { setImmersive } from '../lib/systemBars';
  import type { LightboxItem } from '../lib/lightbox';
  import { startWebPip, webPipAvailable, type WebPip } from '../lib/call/screen/webPip';
  import type { ScreenShareView } from '../lib/call/screen/view';
  import type { ScreenPipPort } from '../lib/call/screen/types';

  // 共有の全画面の表示（重ねて開く）。写真の拡大表示（Lightbox）と同じ部品（LightboxView）に、ライブの映像を載せる。
  // 拡大・移動（ピンチ・ダブルタップ・ホイール・ドラッグ）と、上のバー・端末の安全域（ノッチ）は、写真の拡大表示と同じもの。
  // 戻る（Android）と Esc で閉じる。小窓（Android は本体の PiP、デスクトップは canvas の映像）と全画面（Android は没入、ほかは Fullscreen API）。
  // 共有者が止めた・いなくなったら閉じる。映像が無いあいだは「映像を待っています」

  let { screen, nameOf, pip = null }: { screen: ScreenShareView; nameOf: (userId: string) => string; pip?: ScreenPipPort | null } = $props();

  const current = $derived(screen.sharers.find((s) => s.peer === screen.selectedPeer) ?? screen.sharers[0] ?? null);
  const open = $derived(screen.viewerOpen && current !== null);
  const kindLabel = $derived(current?.source === 'camera' ? 'カメラ' : '画面');
  const heading = $derived(current ? `${nameOf(current.userId)}の${kindLabel}` : '');

  let root = $state<HTMLElement | null>(null);
  /** LightboxView の最上位の要素（全画面・フォーカス用） */
  let fullscreen = $state(false);
  let webPipOn = $state(false);
  let pipNative = $state(false);
  let immersive = false;
  let web: WebPip | null = null;
  /** 開いた回の番号。閉じたあとに終わった非同期（小窓・全画面）を、後始末して捨てるための印 */
  let session = 0;
  /** 開く前にフォーカスがあった場所（閉じたら戻す） */
  let returnFocus: HTMLElement | null = null;

  /** 共有の映像を、拡大表示の 1 件として渡す（フレームが変わっても同じ key なので、拡大・移動は保つ） */
  const item = $derived<LightboxItem | null>(
    current?.dataUrl ? { src: current.dataUrl, alt: heading, downloadUrl: current.dataUrl, key: `screen:${current.peer}` } : null,
  );
  /** いま表示している画像の要素（小窓の映像の元） */
  const shownImage = (): HTMLImageElement | null => root?.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image') ?? null;

  // 共有者が見つからなくなったら閉じる（ほかに共有者がいれば、ほかへ）
  $effect(() => {
    if (screen.viewerOpen && current === null) screen.closeViewer();
  });

  // 開いたら表示にフォーカスを移し、閉じたら元の場所へ戻す。外から閉じられたときは、全画面・小窓も片付ける
  $effect(() => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      untrack(() => root?.focus());
      return;
    }
    untrack(() => {
      session++;
      void leaveFullscreen();
      stopWeb();
      const back = returnFocus;
      returnFocus = null;
      if (back?.isConnected) back.focus();
    });
  });

  // 開いているあいだだけ、戻る（Android）と Esc に応える
  $effect(() => {
    if (!open) return;
    // 登録と外すのは、この effect の依存にしない（ui の一覧を読んで書くと、effect が自分で回り続けてしまう）
    const off = untrack(() => ui.addPluginBack(() => close()));
    const onKey = (e: KeyboardEvent) => {
      // 上の層や入力欄の操作を奪わない。
      if (e.defaultPrevented || ui.lightbox || ui.confirmReq || commandHost.paletteOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      untrack(off);
      window.removeEventListener('keydown', onKey);
    };
  });

  // 小窓の状態（Android の本体の PiP）。外から閉じられたら反映する
  $effect(() => {
    if (!pip) return;
    pipNative = pip.active;
    return pip.onChange(() => (pipNative = pip.active));
  });

  // デスクトップの全画面（Fullscreen API）の状態
  $effect(() => {
    const onChange = () => (fullscreen = document.fullscreenElement !== null && document.fullscreenElement === root);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  });

  // 新しい画像が来たら、小窓の映像も描き替える（読み込めてから描く）
  $effect(() => {
    const url = current?.dataUrl;
    if (!url || !web) return;
    const probe = new Image();
    probe.onload = () => web?.draw(probe);
    probe.src = url;
  });

  function close(): void {
    screen.closeViewer();
  }

  onDestroy(() => {
    session++;
    void leaveFullscreen();
    stopWeb();
  });

  function stopWeb(): void {
    const w = web;
    web = null;
    webPipOn = false;
    w?.close();
  }

  // ---- 全画面・小窓 ----

  async function toggleFullscreen(): Promise<void> {
    if (isAndroid()) {
      const want = !immersive;
      const mine = session;
      immersive = want;
      try {
        await setImmersive(want);
      } catch (e) {
        if (mine === session) immersive = !want;
        console.error('没入モードにできませんでした', e);
        if (mine === session) ui.toast('全画面にできませんでした', 'error');
        return;
      }
      // 終わる前に閉じていたら、閉じた側の後始末（解除）に任せる
      if (mine !== session) {
        if (want) await setImmersive(false).catch(() => {});
        return;
      }
      fullscreen = want;
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root?.requestFullscreen();
    } catch (e) {
      console.error('全画面にできませんでした', e);
      ui.toast('全画面にできませんでした', 'error');
    }
  }

  async function leaveFullscreen(): Promise<void> {
    if (immersive) {
      immersive = false;
      fullscreen = false;
      await setImmersive(false).catch(() => {});
    } else if (document.fullscreenElement && document.fullscreenElement === root) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  async function togglePip(): Promise<void> {
    if (pip?.supported) {
      const img = shownImage();
      const aspect = img && img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : undefined;
      const ok = await pip.enter(aspect ? { aspect } : undefined).catch(() => false);
      if (!ok) ui.toast('小窓にできませんでした', 'error');
      return;
    }
    if (web) {
      stopWeb();
      return;
    }
    const imgEl = shownImage();
    if (!imgEl || !webPipAvailable()) {
      ui.toast('この環境では小窓を出せません', 'error');
      return;
    }
    const mine = session;
    try {
      const made = await startWebPip(imgEl, () => {
        if (web === made) stopWeb();
      });
      // 始まる前に閉じていた・ほかで止めた場合は、今できた小窓を直ちに片付ける
      if (mine !== session || !open) {
        made.close();
        return;
      }
      web = made;
      webPipOn = true;
    } catch (e) {
      console.error('小窓にできませんでした', e);
      if (mine === session) {
        stopWeb();
        ui.toast('小窓にできませんでした', 'error');
      }
    }
  }

  const pipAvailable = $derived((pip?.supported ?? false) || webPipAvailable());
</script>

{#if open && current}
  <LightboxView
    {item}
    open
    layer={60}
    navigable={false}
    closeOnEscape={false}
    chrome={!pipNative}
    download={false}
    class="screen-viewer"
    tabIndex={-1}
    onclose={close}
    bind:element={root}
  >
    {#snippet title()}
      {#if screen.sharers.length > 1}
        <div class="segmented screen-viewer-tabs" role="radiogroup" aria-label="見る画面">
          {#each screen.sharers as s (s.peer)}
            <button
              type="button"
              role="radio"
              class="screen-viewer-tab"
              aria-checked={s.peer === current.peer}
              class:active={s.peer === current.peer}
              onclick={() => screen.selectPeer(s.peer)}>{nameOf(s.userId)}</button
            >
          {/each}
        </div>
      {:else}
        <span class="screen-viewer-title">{heading}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if pipAvailable}
        <IconButton label="小窓で見る" title="小窓で見る" icon={PictureInPicture} active={webPipOn} onclick={() => void togglePip()} disabled={!current.dataUrl} />
      {/if}
      <IconButton
        label={fullscreen ? '全画面を解く' : '全画面'}
        title={fullscreen ? '全画面を解く' : '全画面'}
        icon={fullscreen ? Minimize : Maximize}
        onclick={() => void toggleFullscreen()}
      />
    {/snippet}
    {#snippet empty()}
      <p class="muted screen-viewer-wait">映像を待っています</p>
    {/snippet}
  </LightboxView>
{/if}

<style>
  .screen-viewer-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-viewer-tabs {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }
  .screen-viewer-wait {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    text-align: center;
    pointer-events: none;
  }
</style>
