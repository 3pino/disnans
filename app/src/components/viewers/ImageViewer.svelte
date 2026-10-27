<script lang="ts">
  import { untrack } from 'svelte';
  import { DOUBLE_TAP_ZOOM, IDENTITY_VIEW, MIN_ZOOM, clampView, pinchView, zoomAt, type Point, type ZoomView } from '../../lib/zoom';
  import { zoomGesture, type GestureFrame } from '../../lib/zoomGesture';
  import type { ViewerProps } from '../../lib/viewers';

  // 画像のビューアー（拡大表示の中）。ピンチ・ダブルタップ・Ctrl+ホイールで拡大し、拡大中は 1 本指（マウスのドラッグ）で動かす。
  // 等倍のときの 1 本指の左右の動きは受けない（Lightbox が前後の切り替えに使う）
  let { src, alt, active, onzoom, ontap }: ViewerProps = $props();

  /** 背景タップで閉じるまでの待ち時間（ダブルタップと区別するため） */
  const CLOSE_DELAY = 300;

  let view = $state<ZoomView>({ ...IDENTITY_VIEW });
  let stageEl = $state<HTMLDivElement>();
  let imgEl = $state<HTMLImageElement>();
  const transform = $derived(`translate(${view.x}px, ${view.y}px) scale(${view.scale})`);
  const zoomed = $derived(view.scale > MIN_ZOOM);
  /** 指の数が変わったときの表示（move はここからの変化） */
  let startView: ZoomView = IDENTITY_VIEW;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const z = zoomed;
    untrack(() => onzoom?.(z));
  });

  // 隣（前後）に回ったら、等倍・中央に戻す
  $effect(() => {
    if (!active) {
      view = { ...IDENTITY_VIEW };
      clearTimeout(closeTimer);
    }
  });

  /** 舞台の中心を原点にした位置（zoomGesture は左上から） */
  function centered(p: Point): Point {
    return { x: p.x - (stageEl?.clientWidth ?? 0) / 2, y: p.y - (stageEl?.clientHeight ?? 0) / 2 };
  }

  /** 表示を、舞台と画像の大きさに合わせて収める */
  function fit(v: ZoomView): ZoomView {
    const stage = { w: stageEl?.clientWidth ?? 0, h: stageEl?.clientHeight ?? 0 };
    const img = { w: imgEl?.offsetWidth ?? 0, h: imgEl?.offsetHeight ?? 0 };
    return clampView(v, stage, img);
  }

  const gesture = {
    panOne: () => active && view.scale > MIN_ZOOM,
    start: () => {
      startView = view;
      clearTimeout(closeTimer);
    },
    move: (first: GestureFrame, now: GestureFrame) => {
      if (!active) return;
      view = fit(pinchView(startView, centered(first.mid), first.dist, centered(now.mid), now.dist));
    },
    tap: (p: Point, double: boolean) => {
      if (!active) return;
      if (double) {
        clearTimeout(closeTimer);
        view = fit(view.scale > MIN_ZOOM ? { ...IDENTITY_VIEW } : zoomAt(view, DOUBLE_TAP_ZOOM, centered(p)));
        return;
      }
      // 拡大中は、タップで閉じない
      if (view.scale > MIN_ZOOM || !ontap) return;
      closeTimer = setTimeout(() => ontap?.(), CLOSE_DELAY);
    },
    wheel: (factor: number, p: Point) => {
      if (active) view = fit(zoomAt(view, view.scale * factor, centered(p)));
    },
  };
</script>

<svelte:window onresize={() => (view = fit(view))} />

<div class="image-viewer" class:zoomed role="presentation" bind:this={stageEl} use:zoomGesture={gesture}>
  <img bind:this={imgEl} class="image-viewer-image" {src} {alt} style:transform draggable="false" />
</div>

<style>
  /* 全画面の操作面。ブラウザー自身のパン・ズームは効かせず、指の動きはすべて zoomGesture と Lightbox で受ける */
  .image-viewer {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    cursor: zoom-out;
  }
  .image-viewer.zoomed {
    cursor: grab;
  }
  .image-viewer-image {
    position: relative;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 96px);
    object-fit: contain;
    border-radius: var(--radius-xs);
    box-shadow: var(--shadow-media);
    pointer-events: none;
  }
</style>
