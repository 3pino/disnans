<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { onDestroy, tick } from 'svelte';
  import Button from './Button.svelte';
  import {
    dropSlot,
    finalPositions,
    keyMoveTarget,
    REVEAL_PX,
    revealAfterEnd,
    rowGesture,
    sameIdOrder,
    slotToIndex,
    TOUCH_DRAG_HOLD_MS,
    type RowGesture,
  } from '../../lib/sortable';
  import { swipeOffset, swipeTriggered } from '../../lib/swipe';

  // 並べ替えのリスト（設定の「＋メニュー」「ナビゲーションバー」で使う）。
  // つまみは無く、行の大部分（ボタン・入力欄・トグルの上を除く）が当たり判定になる:
  // - マウス・ペン: 縦に動かすと並べ替え。横に左へ動かすと削除のスワイプ。
  // - タッチ: 押したまま（約 0.4 秒）動かすと並べ替え。その前の縦の動きはページのスクロール。左への横は削除のスワイプ。
  // - キーボード: 行にフォーカスがあるとき、上下キー（Home・End も）で動かす。
  // 削除（removable が true の行だけ）は、左へスワイプして出る「削除」ボタンを押すと消える（押して確定の2段）。
  // 削除できるかは親が決める。並びは onmove で親が決めて保存する。行の中身は row（snippet）で渡す

  let {
    items,
    getId,
    getLabel,
    onmove,
    onremove,
    removable,
    row,
    class: className = '',
  }: {
    items: T[];
    /** 項目の ID（並びを作り直しても同じ行だと分かるもの） */
    getId: (item: T) => string;
    /** 行の読み上げの名前 */
    getLabel: (item: T) => string;
    /** 項目を、並びの toIndex 番目（動かしたあとの位置）に動かす。親が並びを保存する */
    onmove: (id: string, toIndex: number) => void;
    /** 削除（左スワイプの「削除」）。removable が true の項目だけ出す */
    onremove?: (id: string) => void;
    /** この項目を左スワイプで削除できるか（省くと削除なし） */
    removable?: (item: T) => boolean;
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

  /** 指の追跡（描画に要らないので非リアクティブ）。mode は決まったジェスチャー */
  type Gesture = {
    id: string;
    index: number;
    pointerId: number;
    pointerType: string;
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    /** 押したまま時間が過ぎた（タッチの並べ替えの条件） */
    held: boolean;
    canRemove: boolean;
    mode: RowGesture | null;
    timer: ReturnType<typeof setTimeout> | null;
    body: HTMLElement;
  };
  let gesture: Gesture | null = null;
  /** 左スワイプ中の行と、その横の動き（描画に要る） */
  let swipingId = $state<string | null>(null);
  let swipeDx = $state(0);
  /** 削除ボタンを出したままの行（離したあと、タップか別の行を押すまで） */
  let revealedId = $state<string | null>(null);

  /**
   * 途中の操作を取り消す（並びが外から変わった・ページを離れた）。
   * 押したまま待つ時間の計測も止める。並べ替えの途中の位置は捨てる（並びは変えない）
   */
  function cancelGesture() {
    const g = gesture;
    if (g) clearTimer(g);
    gesture = null;
    drag = null;
    swipingId = null;
    swipeDx = 0;
  }

  onDestroy(() => cancelGesture());

  /** 並べている項目の ID の並び。ドラッグや左スワイプの途中で変わったら、その操作は取り消す（位置がずれて別の項目を動かさないため） */
  let lastIds: string[] | null = null;
  $effect.pre(() => {
    const ids = items.map(getId);
    if (lastIds !== null && !sameIdOrder(lastIds, ids)) cancelGesture();
    lastIds = ids;
  });

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
    // 行の位置と並びの数がそろっていないときは動かさない（取り消しの直前の描画）
    const to = rowTops[targets[i]];
    const from = rowTops[i];
    if (!to || !from) return undefined;
    const d = to.top - from.top;
    return d === 0 ? undefined : `translateY(${d}px)`;
  }

  /** 中身（行の body）の横の位置。左スワイプ中は指に合わせ、離したあとは削除ボタンを出した位置 */
  function bodyTransform(id: string): string | undefined {
    if (swipingId === id) return `translateX(${swipeOffset(swipeDx)}px)`;
    if (revealedId === id) return `translateX(${-REVEAL_PX}px)`;
    return undefined;
  }

  /** 押したところが、ボタン・入力欄などの操作部品の中か */
  function inControl(target: EventTarget | null, body: HTMLElement): boolean {
    if (!(target instanceof Element) || target === body) return false;
    return target.closest('button, input, select, textarea, a, label, [role="switch"], [contenteditable="true"]') !== null;
  }

  function clearTimer(g: Gesture) {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
  }

  function capture(g: Gesture) {
    try {
      g.body.setPointerCapture(g.pointerId);
    } catch {
      // 捕まえられなかったら、指が行の外に出たところで止まる（並べ替えは離したときの位置で決まる）
    }
  }

  function startDrag(g: Gesture, y: number) {
    if (!listEl) return;
    rowTops = [...listEl.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    g.mode = 'drag';
    capture(g);
    drag = { id: g.id, from: g.index, startY: y, y, slot: g.index };
  }

  function onRowDown(e: PointerEvent, i: number, item: T) {
    if (e.button !== 0 || !listEl) return;
    const body = e.currentTarget as HTMLElement;
    // 行を押したら、開いていた削除ボタンは閉じる
    revealedId = null;
    if (inControl(e.target, body)) return;
    const g: Gesture = {
      id: getId(item),
      index: i,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      sx: e.clientX,
      sy: e.clientY,
      dx: 0,
      dy: 0,
      held: false,
      canRemove: !!onremove && !!removable?.(item),
      mode: null,
      timer: null,
      body,
    };
    gesture = g;
    if (e.pointerType === 'touch') {
      g.timer = setTimeout(() => {
        g.timer = null;
        if (gesture !== g || g.mode !== null) return;
        g.held = true;
        startDrag(g, g.sy);
      }, TOUCH_DRAG_HOLD_MS);
    }
  }

  function onRowMove(e: PointerEvent) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    g.dx = e.clientX - g.sx;
    g.dy = e.clientY - g.sy;
    if (g.mode === null) {
      const next = rowGesture(g.pointerType, g.dx, g.dy, g.held);
      if (next === null) return;
      // 削除できない行の左スワイプは何もしない。ページのスクロール・右への動きも、ここで手を離す
      if (next === 'scroll' || next === 'ignore' || (next === 'swipe' && !g.canRemove)) {
        clearTimer(g);
        gesture = null;
        return;
      }
      clearTimer(g);
      if (next === 'drag') {
        startDrag(g, e.clientY);
      } else {
        g.mode = 'swipe';
        capture(g);
        swipingId = g.id;
        swipeDx = 0;
      }
    }
    if (g.mode === 'drag' && drag) {
      e.preventDefault();
      drag = { ...drag, y: e.clientY, slot: dropSlot(rowTops, e.clientY) };
    } else if (g.mode === 'swipe') {
      swipeDx = Math.min(0, g.dx);
    }
  }

  function onRowEnd(e: PointerEvent, cancelled: boolean) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    clearTimer(g);
    gesture = null;
    if (g.mode === 'drag') {
      if (cancelled || !drag) {
        drag = null;
        return;
      }
      const { id, from, slot } = drag;
      const to = slotToIndex(from, slot);
      if (to === from) {
        drag = null;
        return;
      }
      void commit(id, to);
    } else if (g.mode === 'swipe') {
      revealedId = revealAfterEnd(g.dx, cancelled) ? g.id : null;
      swipingId = null;
      swipeDx = 0;
    }
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
    if (!listEl || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    listEl.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]').forEach((el) => {
      const old = before.get(el.dataset.sortableId ?? '');
      if (old === undefined) return;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
    });
  }

  /** 削除ボタン。並べ替えの途中・ほかの操作の後に消す */
  function remove(id: string) {
    revealedId = null;
    onremove?.(id);
  }

  /** 押したまま動かす途中で、タッチのページのスクロールを止める（並べ替えの間だけ） */
  function noScrollWhileDragging(node: HTMLElement) {
    const stop = (ev: TouchEvent) => {
      if (gesture?.mode === 'drag') ev.preventDefault();
    };
    node.addEventListener('touchmove', stop, { passive: false });
    return {
      destroy() {
        node.removeEventListener('touchmove', stop);
      },
    };
  }

  async function onRowKey(e: KeyboardEvent, i: number) {
    // 行そのものにフォーカスがあるときだけ（中のボタン・入力欄の操作は、そのまま）
    if (e.target !== e.currentTarget) return;
    const to = keyMoveTarget(e.key, i, items.length);
    if (to === null) return;
    e.preventDefault();
    const id = getId(items[i]);
    await commit(id, to);
    // 並びが変わると行の DOM が動くため、同じ行にフォーカスを戻す
    const moved = listEl?.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]');
    const row = moved ? [...moved].find((el) => el.dataset.sortableId === id) : undefined;
    row?.querySelector<HTMLElement>('.sortable-list-body')?.focus();
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
    {@const canRemove = !!onremove && !!removable?.(item)}
    <div
      class="sortable-list-item"
      class:sortable-list-item-dragging={drag?.id === id}
      data-sortable-id={id}
      style:transform={rowTransform(i)}
    >
      <!-- 行は、上下キーで動かせるフォーカスの対象（役割は group）。中の操作部品は、そのまま使える -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="sortable-list-body"
        class:sortable-list-body-moving={swipingId === id}
        role="group"
        tabindex="0"
        aria-label="{getLabel(item)} を並べ替える（上下キーで動かす）"
        style:transform={bodyTransform(id)}
        use:noScrollWhileDragging
        onpointerdown={(e) => onRowDown(e, i, item)}
        onpointermove={onRowMove}
        onpointerup={(e) => onRowEnd(e, false)}
        onpointercancel={(e) => onRowEnd(e, true)}
        onlostpointercapture={(e) => {
          // 行の中の文字が暗黙の捕捉を持つと、捕捉の解放が泡のように行へ届く。行自身の捕捉が外れたときだけ取り消す
          if (e.target === e.currentTarget) onRowEnd(e, true);
        }}
        onkeydown={(e) => onRowKey(e, i)}
        oncontextmenu={(e) => {
          // 長押しで出る文脈メニュー（Android・iOS のコピーなど）は行では出さない。入力欄などの操作部品は除く
          if (!inControl(e.target, e.currentTarget as HTMLElement)) e.preventDefault();
        }}
      >
        {@render row(item)}
      </div>
      {#if canRemove}
        <div
          class="sortable-list-delete-slot"
          class:sortable-list-delete-shown={revealedId === id || (swipingId === id && swipeTriggered(swipeDx))}
          style:width="{REVEAL_PX}px"
        >
          <Button variant="danger" aria-label="{getLabel(item)} を削除" onclick={() => remove(id)}>削除</Button>
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .sortable-list {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* ドラッグの間は文字を選べないようにする */
  .sortable-list-dragging {
    user-select: none;
  }
  .sortable-list-item {
    position: relative;
    display: flex;
    align-items: center;
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
  /* 行の大部分が当たり判定。縦はページのスクロールに任せ（タッチの並べ替えは長押しのあとだけ）、横の動きは JS で受ける */
  .sortable-list-body {
    flex: 1;
    min-width: 0;
    position: relative;
    cursor: grab;
    touch-action: pan-y;
    transition: transform 180ms ease;
    border-radius: var(--radius-sm);
    /* 長押し（タッチ）で文字が選ばれたり、読み上げ・コピーの枠が出たりしないように。入力欄などは除く */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  /* 行の中身は親の snippet で来るので、中の入力欄は :global で指す */
  .sortable-list-body :global(input),
  .sortable-list-body :global(textarea),
  .sortable-list-body :global(select),
  .sortable-list-body :global([contenteditable='true']) {
    -webkit-user-select: text;
    user-select: text;
  }
  .sortable-list-body-moving {
    transition: none;
  }
  .sortable-list-body:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .sortable-list-item-dragging .sortable-list-body {
    cursor: grabbing;
  }
  /* 左スワイプで出る「削除」。出していないときは見えず、触れず、読み上げもされない */
  .sortable-list-delete-slot {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    visibility: hidden;
  }
  .sortable-list-delete-shown {
    visibility: visible;
  }
  @media (prefers-reduced-motion: reduce) {
    .sortable-list-item,
    .sortable-list-body {
      transition: none;
    }
  }
</style>
