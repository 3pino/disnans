<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minimize from '@lucide/svelte/icons/minimize';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture';
  import SwitchCamera from '@lucide/svelte/icons/switch-camera';
  import IconButton from './ui/IconButton.svelte';
  import LightboxView from './LightboxView.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { isAndroid } from '../lib/platform';
  import { setImmersive } from '../lib/systemBars';
  import { orientation } from '../lib/stores/orientation.svelte';
  import type { LightboxItem } from '../lib/lightbox';
  import { startWebPip, webPipAvailable, type WebPip } from '../lib/call/screen/webPip';
  import type { ScreenShareView } from '../lib/call/screen/view';
  import type { ScreenPipPort } from '../lib/call/screen/types';
  import { orderViews, viewLabel, type ScreenViewEntry } from '../lib/call/screen/order';

  // 共有の全画面の表示（重ねて開く）。写真の拡大表示（Lightbox）と同じ部品（LightboxView）に、ライブの映像を載せる。
  // 拡大・移動（ピンチ・ダブルタップ・ホイール・ドラッグ）と、上のバー・端末の安全域（ノッチ）は、写真の拡大表示と同じもの。
  // 戻る（Android）と Esc で閉じる。小窓（Android は本体の PiP、デスクトップは canvas の映像）と全画面（Android は没入、ほかは Fullscreen API）。
  // 共有者が止めた・いなくなったら閉じる。映像が無いあいだは「映像を待っています」

  let { screen, nameOf, pip = null, myUserId = null }: { screen: ScreenShareView; nameOf: (userId: string) => string; pip?: ScreenPipPort | null; myUserId?: string | null } = $props();

  // 見られる映像（自分のこのデバイス > 自分の別のデバイス > ほかの人）。選ばれているもの（無ければ先頭の相手）を出す
  const views = $derived(orderViews(screen, myUserId));
  const current = $derived(views.find((v) => v.peer === screen.selectedPeer) ?? views.find((v) => !v.local) ?? null);
  const open = $derived(screen.viewerOpen && current !== null);
  const heading = $derived(current ? viewLabel(current, nameOf) : '');
  /** 自分のカメラ（動画の要素に直接入れる。静止画の拡大表示には載らない） */
  const localCamera = $derived(current?.local === true && screen.localStream !== null);
  /** Android は、全画面ボタンではなく映像のタップで没入（バーを隠す）。それ以外は、従来の全画面ボタンとタップで閉じる */
  const android = isAndroid();

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
    current?.dataUrl && !localCamera ? { src: current.dataUrl, alt: heading, downloadUrl: current.dataUrl, key: `screen:${current.peer}` } : null,
  );
  /** いま表示している画像の要素（小窓の映像の元） */
  const shownImage = (): HTMLImageElement | null => root?.querySelector<HTMLImageElement>('.lightbox-slide-current .image-viewer-image') ?? null;

  // 見る映像が無くなったら閉じる（ほかにあれば、ほかへ）
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

  // 写真と同じく、拡大して見ている間は「メディア」の自動回転に含める。閉じる・共有終了・破棄で解除する。
  $effect(() => {
    if (!open) return;
    return untrack(() => orientation.holdMediaView());
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

  /** 見る画面の切り替えの短い名前 */
  function tabLabel(v: ScreenViewEntry): string {
    if (v.local) return '自分';
    const name = nameOf(v.userId ?? '');
    return v.mine ? `${name}（別のデバイス）` : name;
  }

  // カメラの映像は、要素に直接入れる（src ではなく srcObject）
  function stream(el: HTMLVideoElement, s: MediaStream) {
    el.srcObject = s;
    void el.play().catch(() => {});
    return {
      update(next: MediaStream) {
        if (el.srcObject !== next) el.srcObject = next;
      },
      destroy() {
        el.srcObject = null;
      },
    };
  }

  /** 自分のカメラを押したとき。映像の上なら、Android は没入の切り替え、ほかは閉じる。映像の外は閉じる */
  function onCameraTap(e: MouseEvent): void {
    if (android && (e.target as HTMLElement).tagName === 'VIDEO') void toggleFullscreen();
    else close();
  }
</script>

{#if open && current}
  <LightboxView
    {item}
    open
    layer={60}
    navigable={false}
    closeOnEscape={false}
    chrome={!pipNative && !(android && fullscreen)}
    download={false}
    class="screen-viewer"
    tabIndex={-1}
    tapMode={android ? 'media' : 'close'}
    onmediatap={() => void toggleFullscreen()}
    onclose={close}
    bind:element={root}
  >
    {#snippet title()}
      {#if views.length > 1}
        <div class="segmented screen-viewer-tabs" role="radiogroup" aria-label="見る画面">
          {#each views as v (v.peer)}
            <button
              type="button"
              role="radio"
              class="screen-viewer-tab"
              aria-checked={v.peer === current.peer}
              class:active={v.peer === current.peer}
              onclick={() => screen.selectPeer(v.peer)}>{tabLabel(v)}</button
            >
          {/each}
        </div>
      {:else}
        <span class="screen-viewer-title">{heading}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if pipAvailable}
        <IconButton label="小窓で見る" title="小窓で見る" icon={PictureInPicture} active={webPipOn} onclick={() => void togglePip()} disabled={!current.dataUrl || localCamera} />
      {/if}
      {#if current.local && screen.source === 'camera' && screen.canSwitchCamera}
        <IconButton label="カメラを切り替え" title="前と後ろのカメラを切り替える" icon={SwitchCamera} disabled={screen.switching} onclick={() => void screen.switchCamera()} />
      {/if}
      <!-- Android は、映像を押して没入する（バーも隠す）ので、全画面のボタンは出さない -->
      {#if !android}
        <IconButton
          label={fullscreen ? '全画面を解く' : '全画面'}
          title={fullscreen ? '全画面を解く' : '全画面'}
          icon={fullscreen ? Minimize : Maximize}
          onclick={() => void toggleFullscreen()}
        />
      {/if}
    {/snippet}
    {#snippet empty()}
      {#if localCamera && screen.localStream}
        <!-- 自分のカメラ（動画）。映像を押すと、Android は没入、ほかは閉じる。映像の外を押すと閉じる -->
        <div class="screen-viewer-camera" role="presentation" onclick={onCameraTap}>
          <video class="screen-viewer-camera-video" use:stream={screen.localStream} muted playsinline aria-label="自分のカメラ"></video>
        </div>
      {:else}
        <p class="muted screen-viewer-wait">映像を待っています</p>
      {/if}
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
  .screen-viewer-camera {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .screen-viewer-camera-video {
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 96px);
    object-fit: contain;
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
