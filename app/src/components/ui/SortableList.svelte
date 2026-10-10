<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import { dropSlot, finalPositions, slotToIndex } from '../../lib/sortable';

  // 並べ替えのリスト（設定の「＋メニュー」「ナビゲーションバー」で使う）。
  // 左のつまみをドラッグすると、ほかの行が動いて空きができ、離すとその空きに入る（入る位置が動いている間に見える）。
  // つまみにフォーカスして上下キー（Home・End も）でも動かせる。並びは onmove で親が決めて保存する。
  // 行の中身は row（snippet）で渡す。アニメーションは CSS の transform で、動きを止める人には出さない

  let {
    items,
    getId,
    getLabel,
    onmove,
    row,
    class: className = '',
  }: {
    items: T[];
    /** 項目の ID（並びを作り直しても同じ行だと分かるもの） */
    getId: (item: T) => string;
    /** つまみの読み上げに使う名前 */
    getLabel: (item: T) => string;
    /** 項目を、並びの toIndex 番目（動かしたあとの位置）に動かす。親が並びを保存する */
    onmove: (id: string, toIndex: number) => void;
    /** 行の中身 */
    row: Snippet<[T]>;
    class?: string;
  } = $props();

  /** ドラッグの状態。from は動かす前の位置、slot は差し込み位置（行の前）、y はポインターの縦位置 */
  type Drag = { id: string; from: number; startY: number; y: number; slot: number };
  let drag = $state<Drag | null>(null);
  /** 離したあと、並びを入れ替えるまでの間は、行の移動（CSS の transition）を止める */
  let settling = $state(false);
  let listEl: HTMLElement | undefined = $state();
  /** ドラッグを始めたときの行の位置（画面の座標）。ドラッグの間は変えない */
  let rowTops: { top: number; bottom: number }[] = [];

  /** ドラッグ中、元の位置 k の行が最終的に入る位置（動かさないときは null） */
  const targets = $derived.by(() => {
    if (!drag) return null;
    const to = slotToIndex(drag.from, drag.slot);
    return to === drag.from ? null : finalPositions(items.length, drag.from, to);
  });

  /** 行の移動（transform）。動かしている行はポインターに合わせ、ほかの行は空きの分だけずらす */
  function rowTransform(i: number): string | undefined {
    if (!drag) return undefined;
    if (i === drag.from) return `translateY(${drag.y - drag.startY}px)`;
    if (!targets) return undefined;
    const d = rowTops[targets[i]].top - rowTops[i].top;
    return d === 0 ? undefined : `translateY(${d}px)`;
  }

  function onGripDown(e: PointerEvent, i: number) {
    if (e.button !== 0 || !listEl) return;
    const grip = e.currentTarget as HTMLElement;
    // 指を離すまで、動きをこのつまみで受ける（マウスが外に出ても続く）
    grip.setPointerCapture(e.pointerId);
    rowTops = [...listEl.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    drag = { id: getId(items[i]), from: i, startY: e.clientY, y: e.clientY, slot: i };
  }

  function onGripMove(e: PointerEvent) {
    if (!drag) return;
    // つまみの touch-action: none と合わせて、ドラッグ中はページを動かさない
    e.preventDefault();
    drag = { ...drag, y: e.clientY, slot: dropSlot(rowTops, e.clientY) };
  }

  function onGripUp() {
    if (!drag) return;
    const { id, from, slot } = drag;
    const to = slotToIndex(from, slot);
    if (to === from) {
      drag = null;
      return;
    }
    void commit(id, to);
  }

  /** ポインターの取り消し（指が外れたなど）。並びは変えず、行は元の位置に戻る */
  function cancelDrag() {
    drag = null;
  }

  /**
   * 並びを動かす。動く前の行の位置（画面の座標。ドラッグ中ならずらした位置）を覚えて、
   * 並べ替えたあとの位置との差から、行を滑らせて移す
   */
  async function commit(id: string, to: number) {
    const before = new Map<string, number>();
    listEl?.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]').forEach((el) => {
      before.set(el.dataset.sortableId ?? '', el.getBoundingClientRect().top);
    });
    settling = true;
    drag = null;
    onmove(id, to);
    await tick();
    slide(before);
    settling = false;
  }

  function slide(before: Map<string, number>) {
    if (!listEl || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    listEl.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]').forEach((el) => {
      const old = before.get(el.dataset.sortableId ?? '');
      if (old === undefined) return;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
    });
  }

  async function onGripKey(e: KeyboardEvent, i: number) {
    let to: number;
    if (e.key === 'ArrowUp') to = i - 1;
    else if (e.key === 'ArrowDown') to = i + 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else return;
    e.preventDefault();
    if (to < 0 || to >= items.length || to === i) return;
    const id = getId(items[i]);
    await commit(id, to);
    // 並びが変わると行の DOM が動くため、同じつまみにフォーカスを戻す
    listEl?.querySelector<HTMLElement>(`[data-sortable-id="${CSS.escape(id)}"] .sortable-list-grip`)?.focus();
  }
</script>

<div
  class="sortable-list {className}"
  class:sortable-list-dragging={drag !== null}
  class:sortable-list-settling={settling}
  bind:this={listEl}
>
  {#each items as item, i (getId(item))}
    {@const id = getId(item)}
    <div
      class="sortable-list-item"
      class:sortable-list-item-dragging={drag?.id === id}
      data-sortable-id={id}
      style:transform={rowTransform(i)}
    >
      <button
        type="button"
        class="sortable-list-grip"
        aria-label="{getLabel(item)} を並べ替える（上下キーで動かす）"
        onpointerdown={(e) => onGripDown(e, i)}
        onpointermove={onGripMove}
        onpointerup={onGripUp}
        onpointercancel={cancelDrag}
        onlostpointercapture={cancelDrag}
        onkeydown={(e) => onGripKey(e, i)}
      >
        <GripVertical size={16} />
      </button>
      <div class="sortable-list-body">
        {@render row(item)}
      </div>
    </div>
  {/each}
</div>

<style>
  .sortable-list {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* ドラッグの間は文字を選べないようにする */
  .sortable-list-dragging {
    user-select: none;
  }
  .sortable-list-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--radius-sm);
    /* ほかの行が空きへ滑る */
    transition: transform 180ms ease;
  }
  /* 動かしている行は、ポインターに遅れずについてくる。離したあとは並びに合わせて滑らせる（Web Animations） */
  .sortable-list-item-dragging,
  .sortable-list-settling .sortable-list-item {
    transition: none;
  }
  .sortable-list-item-dragging {
    z-index: 1;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .sortable-list-grip {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: grab;
    /* タッチで押したとき、ページがスクロールしないようにする */
    touch-action: none;
  }
  .sortable-list-grip:hover {
    background: var(--hover);
    color: var(--text);
  }
  .sortable-list-grip:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  .sortable-list-item-dragging .sortable-list-grip {
    cursor: grabbing;
  }
  .sortable-list-body {
    flex: 1;
    min-width: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .sortable-list-item {
      transition: none;
    }
  }
</style>
