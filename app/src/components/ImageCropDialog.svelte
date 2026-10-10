<script lang="ts">
  import { untrack } from 'svelte';
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import {
    clampRect,
    displayToSource,
    fitDisplay,
    fullRect,
    isFullRect,
    moveRect,
    rectToDisplay,
    resizeRect,
    type Corner,
    type CropRect,
    type ImageInfo,
  } from '../lib/imageCrop';

  // 画像を切り抜く範囲を選ぶダイアログ。決定すると閉じる（切り抜きは送信するときに行う）
  let {
    file,
    info,
    value,
    onpick,
    onclose,
  }: {
    file: File;
    info: ImageInfo;
    /** 今の切り抜き範囲（元の画像の画素。null は全体） */
    value: CropRect | null;
    onpick: (crop: CropRect | null) => void;
    onclose: () => void;
  } = $props();

  // 開いたときの範囲と画像の大きさで始める（以後は変わらない）
  let rect = $state<CropRect>(untrack(() => value ?? fullRect(info)));

  // 画像の表示。枠の幅に合わせ、高さは画面の半分まで（小さい画像は拡大しない）。
  // 四隅のハンドルは角から半分（16px）はみ出すので、その分の余白を枠の中に取っておく
  const PAD = 16;
  const boxH = Math.min(420, Math.round(window.innerHeight * 0.5));
  let areaW = $state(0);
  const fit = $derived(
    fitDisplay(info, { width: Math.max(1, (areaW || 320) - PAD * 2), height: Math.max(1, boxH - PAD * 2) }),
  );
  const shown = $derived(rectToDisplay(rect, fit.scale));

  let url = $state('');
  $effect(() => {
    const u = URL.createObjectURL(file);
    url = u;
    return () => URL.revokeObjectURL(u);
  });

  // ドラッグ（マウス・タッチ・ペンは同じ pointer イベント）。動かし始めた範囲からの合計で計算する
  let drag: { mode: 'move' | Corner; startX: number; startY: number; start: CropRect } | null = null;

  function onpointerdown(e: PointerEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-crop]');
    if (!target || !target.dataset.crop) return;
    e.preventDefault();
    const mode = target.dataset.crop as 'move' | Corner;
    drag = { mode, startX: e.clientX, startY: e.clientY, start: rect };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onpointermove(e: PointerEvent) {
    if (!drag) return;
    const dx = displayToSource(e.clientX - drag.startX, fit.scale);
    const dy = displayToSource(e.clientY - drag.startY, fit.scale);
    rect =
      drag.mode === 'move'
        ? moveRect(drag.start, dx, dy, info)
        : resizeRect(drag.start, drag.mode, dx, dy, info);
  }

  function onpointerup() {
    drag = null;
  }

  function decide() {
    const r = clampRect(rect, info);
    onpick(isFullRect(r, info) ? null : r);
  }
</script>

<Modal title="切り抜き" {onclose} width={460}>
  <p class="image-crop-source muted">
    元の画像: {info.width} × {info.height} · 切り抜き後: {rect.w} × {rect.h}
  </p>

  <div class="image-crop-area" bind:clientWidth={areaW} style:height="{boxH}px">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="image-crop-stage"
      style:width="{fit.width}px"
      style:height="{fit.height}px"
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      onpointercancel={onpointerup}
    >
      {#if url}<img class="image-crop-img" src={url} alt="" draggable="false" />{/if}
      <div
        class="image-crop-box"
        data-crop="move"
        style:left="{shown.x}px"
        style:top="{shown.y}px"
        style:width="{shown.w}px"
        style:height="{shown.h}px"
      >
        <span class="image-crop-handle image-crop-handle-nw" data-crop="nw"></span>
        <span class="image-crop-handle image-crop-handle-ne" data-crop="ne"></span>
        <span class="image-crop-handle image-crop-handle-sw" data-crop="sw"></span>
        <span class="image-crop-handle image-crop-handle-se" data-crop="se"></span>
      </div>
    </div>
  </div>

  <div class="modal-actions">
    <Button onclick={onclose}>キャンセル</Button>
    <Button variant="primary" onclick={decide}>決定</Button>
  </div>
  <p class="image-crop-note muted">
    送るときに切り抜きます。形式は JPEG（透過がある画像は PNG）になります。
  </p>
</Modal>

<style>
  .image-crop-source {
    margin: -6px 0 12px;
    font-size: 13px;
  }
  .image-crop-area {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  /* 表示の大きさは script で決める。ドラッグ中に画面がスクロールしないように touch-action を止める */
  .image-crop-stage {
    position: relative;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .image-crop-img {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
    -webkit-user-drag: none;
  }
  /* 範囲の外を暗くする（大きい影を枠の外へ広げる）。枠の中は見える */
  .image-crop-box {
    position: absolute;
    box-sizing: border-box;
    border: 1px solid #fff;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    cursor: move;
  }
  /* 角のハンドルは指で触れる大きさにする（見た目の点より大きい透明な当たり判定） */
  .image-crop-handle {
    position: absolute;
    width: 32px;
    height: 32px;
    margin: -16px 0 0 -16px;
    cursor: pointer;
  }
  .image-crop-handle::after {
    content: '';
    position: absolute;
    left: 10px;
    top: 10px;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  }
  .image-crop-handle-nw {
    left: 0;
    top: 0;
    cursor: nwse-resize;
  }
  .image-crop-handle-ne {
    left: 100%;
    top: 0;
    cursor: nesw-resize;
  }
  .image-crop-handle-sw {
    left: 0;
    top: 100%;
    cursor: nesw-resize;
  }
  .image-crop-handle-se {
    left: 100%;
    top: 100%;
    cursor: nwse-resize;
  }
  .image-crop-note {
    margin: 12px 0 0;
    font-size: 12px;
    line-height: 1.6;
  }
</style>
