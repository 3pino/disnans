<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import Maximize from '@lucide/svelte/icons/maximize';
  import Minimize from '@lucide/svelte/icons/minimize';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture';
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import IconButton from './ui/IconButton.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { isAndroid } from '../lib/platform';
  import { setImmersive } from '../lib/systemBars';
  import { clampView, containSize, doubleTapView, isDoubleTap, MIN_ZOOM, pinchView, wheelAction, zoomAt, type ViewState } from '../lib/call/screen/stage';
  import { startWebPip, webPipAvailable, type WebPip } from '../lib/call/screen/webPip';
  import type { ScreenShareView } from '../lib/call/screen/view';
  import type { ScreenPipPort } from '../lib/call/screen/types';

  // 共有の全画面の表示（重ねて開く）。拡大は指・ホイール・ダブルタップで、カーソルや指の位置を中心に。
  // 戻る（Android）と Esc で閉じる。小窓（Android は本体の PiP、デスクトップは canvas の映像）と全画面（Android は没入、ほかは Fullscreen API）。
  // 共有者が止めた・いなくなったら閉じる。映像が無いあいだは「映像を待っています」

  let { screen, nameOf, pip = null }: { screen: ScreenShareView; nameOf: (userId: string) => string; pip?: ScreenPipPort | null } = $props();

  const current = $derived(screen.sharers.find((s) => s.peer === screen.selectedPeer) ?? screen.sharers[0] ?? null);
  const open = $derived(screen.viewerOpen && current !== null);
  const kindLabel = $derived(current?.source === 'camera' ? 'カメラ' : '画面');
  const title = $derived(current ? `${nameOf(current.userId)}の${kindLabel}` : '');

  let root = $state<HTMLElement | null>(null);
  let stageEl = $state<HTMLElement | null>(null);
  let imgEl = $state<HTMLImageElement | null>(null);
  let natural = $state({ w: 0, h: 0 });
  let view = $state<ViewState>({ scale: 1, x: 0, y: 0 });
  let fullscreen = $state(false);
  let webPipOn = $state(false);
  let pipNative = $state(false);
  let immersive = false;
  let web: WebPip | null = null;
  /** 開いた回の番号。閉じたあとに終わった非同期（小窓・全画面）を、後始末して捨てるための印 */
  let session = 0;
  /** 開く前にフォーカスがあった場所（閉じたら戻す） */
  let returnFocus: HTMLElement | null = null;

  const zoomable = $derived(view.scale > MIN_ZOOM + 1e-6);

  // 共有者が見つからなくなったら閉じる（ほかに共有者がいれば、ほかへ）
  $effect(() => {
    if (screen.viewerOpen && current === null) screen.closeViewer();
  });

  // 別の人の画面に替わったら、表示は既定（画面全体）に戻す
  const peer = $derived(current?.peer ?? null);
  $effect(() => {
    void peer;
    untrack(() => (view = { scale: 1, x: 0, y: 0 }));
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
      if (e.key !== 'Escape') return;
      // 上に重なっているもの（画像の全画面・確認・コマンドパレット）が先に閉じる。ここでは何もしない
      if (ui.lightbox || ui.confirmReq || commandHost.paletteOpen) return;
      e.preventDefault();
      close();
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

  // 新しい画像が来たら、小窓の映像も描き替える
  $effect(() => {
    void current?.dataUrl;
    if (web && imgEl) web.draw(imgEl);
  });

  function onImageLoad(): void {
    if (!imgEl) return;
    natural = { w: imgEl.naturalWidth, h: imgEl.naturalHeight };
    if (web) web.draw(imgEl);
  }

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

  function stageSize(): { w: number; h: number } {
    return { w: stageEl?.clientWidth ?? 0, h: stageEl?.clientHeight ?? 0 };
  }

  function fit(v: ViewState): ViewState {
    const stage = stageSize();
    return clampView(v, stage, containSize(natural, stage));
  }

  function zoomTo(scale: number, p: { x: number; y: number }): void {
    view = fit(zoomAt(view, scale, p.x, p.y));
  }

  function rel(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = stageEl?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  }

  // ---- 指・マウスの操作（拡大中はドラッグで移動、2 本の指でピンチ、ダブルタップで拡大・戻す） ----

  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { v0: ViewState; m0: { x: number; y: number }; d0: number } | null = null;
  let moved = false;
  let lastTap: { t: number; x: number; y: number } | null = null;

  function spread(): number {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
  function middle(): { x: number; y: number } {
    const all = [...pointers.values()];
    return { x: all.reduce((s, p) => s + p.x, 0) / all.length, y: all.reduce((s, p) => s + p.y, 0) / all.length };
  }

  function restartGesture(): void {
    if (pointers.size === 0) gesture = null;
    else if (pointers.size === 1) gesture = { v0: view, m0: [...pointers.values()][0]!, d0: 1 };
    else gesture = { v0: view, m0: middle(), d0: spread() };
  }

  function onDown(e: PointerEvent): void {
    if (!current?.dataUrl) return;
    stageEl?.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, rel(e));
    if (pointers.size === 1) moved = false;
    restartGesture();
  }

  function onMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    const before = pointers.get(e.pointerId)!;
    const now = rel(e);
    pointers.set(e.pointerId, now);
    if (!gesture) return;
    if (Math.hypot(now.x - before.x, now.y - before.y) > 0) moved = true;
    if (pointers.size === 1) {
      view = fit(pinchView(gesture.v0, gesture.m0, 1, now, 1));
    } else if (pointers.size === 2 && gesture.d0 > 0) {
      view = fit(pinchView(gesture.v0, gesture.m0, gesture.d0, middle(), spread()));
    }
  }

  function onUp(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId)!;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (wasSingle && !moved && e.type === 'pointerup') {
      const tap = { t: performance.now(), x: p.x, y: p.y };
      if (isDoubleTap(lastTap, tap)) {
        view = fit(doubleTapView(view, p));
        lastTap = null;
      } else {
        lastTap = tap;
      }
    }
    restartGesture();
  }

  // ホイール（Ctrl / Meta で拡大縮小、拡大中は移動）。ページを止めるため passive を外す
  function wheel(node: HTMLElement) {
    const fn = (e: WheelEvent) => {
      const a = wheelAction(e, { scale: view.scale, embedded: false, pageHeight: node.clientHeight });
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'zoom') zoomTo(view.scale * a.factor, rel(e));
      else view = fit({ ...view, x: view.x - a.dx, y: view.y - a.dy });
    };
    node.addEventListener('wheel', fn, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', fn) };
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
      const aspect = natural.w > 0 && natural.h > 0 ? { width: natural.w, height: natural.h } : undefined;
      const ok = await pip.enter(aspect ? { aspect } : undefined).catch(() => false);
      if (!ok) ui.toast('小窓にできませんでした', 'error');
      return;
    }
    if (web) {
      stopWeb();
      return;
    }
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
  <div class="screen-viewer" class:screen-viewer-pip={pipNative} bind:this={root} role="dialog" aria-modal="true" aria-label={title} tabindex="-1">
    {#if !pipNative}
      <header class="screen-viewer-bar">
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
          <span class="screen-viewer-title">{title}</span>
        {/if}
        <span class="screen-viewer-actions">
          <IconButton label="拡大" title="拡大" icon={ZoomIn} onclick={() => zoomTo(view.scale * 1.25, { x: 0, y: 0 })} disabled={!current.dataUrl} />
          <IconButton label="縮小" title="縮小" icon={ZoomOut} onclick={() => zoomTo(view.scale / 1.25, { x: 0, y: 0 })} disabled={!zoomable} />
          <IconButton label="等倍に戻す" title="等倍に戻す" icon={RotateCcw} onclick={() => (view = { scale: 1, x: 0, y: 0 })} disabled={!zoomable} />
          {#if pipAvailable}
            <IconButton label="小窓で見る" title="小窓で見る" icon={PictureInPicture} active={webPipOn} onclick={() => void togglePip()} disabled={!current.dataUrl} />
          {/if}
          <IconButton
            label={fullscreen ? '全画面を解く' : '全画面'}
            title={fullscreen ? '全画面を解く' : '全画面'}
            icon={fullscreen ? Minimize : Maximize}
            onclick={() => void toggleFullscreen()}
          />
          <IconButton label="閉じる" title="閉じる（Esc）" icon={X} onclick={close} />
        </span>
      </header>
    {/if}
    <div
      class="screen-viewer-stage"
      class:screen-viewer-zoomed={zoomable}
      bind:this={stageEl}
      use:wheel
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
      role="presentation"
    >
      {#if current.dataUrl}
        <img
          bind:this={imgEl}
          class="screen-viewer-image"
          src={current.dataUrl}
          alt={title}
          draggable="false"
          style:transform={`translate(${view.x}px, ${view.y}px) scale(${view.scale})`}
          onload={onImageLoad}
        />
      {:else}
        <p class="muted screen-viewer-wait">映像を待っています</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .screen-viewer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    min-width: 0;
    min-height: 0;
  }
  .screen-viewer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex: none;
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    min-width: 0;
  }
  .screen-viewer-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--fw-semibold);
  }
  .screen-viewer-actions {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .screen-viewer-tabs {
    min-width: 0;
    overflow-x: auto;
  }
  .screen-viewer-stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    touch-action: none;
  }
  .screen-viewer-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transform-origin: center center;
    user-select: none;
    -webkit-user-drag: none;
  }
  .screen-viewer-zoomed {
    cursor: grab;
  }
  .screen-viewer-wait {
    text-align: center;
  }
</style>
