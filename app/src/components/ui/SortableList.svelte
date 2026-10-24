<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { onDestroy, tick } from 'svelte';
  import {
    DELETE_MODE_HOLD_MS,
    dragHoldMs,
    dropSlot,
    finalPositions,
    keyMoveTarget,
    rowGesture,
    sameIdOrder,
    slotToIndex,
    type RowGesture,
    type SortableRow,
  } from '../../lib/sortable';

  // 並べ替えのリスト（設定の「＋メニュー」「ナビゲーションバー」で使う）。
  // 行の大部分（ボタン・入力欄・トグルの上を除く）が当たり判定:
  // - マウス・ペン: 縦に動かすと並べ替え。
  // - タッチ: 押したまま（約 0.4 秒）動かすと並べ替え。その前の縦の動きはページのスクロール。
  // - 動かさずに押し続ける（約 0.7 秒）と削除モードに入る。削除モードでは、操作部品（トグル・入力欄）が × に替わる（削除できる項目だけ）。
  //   削除モードでも並べ替えはできる（押す時間が短くなる）。リストの外をタップするか Escape で終わる。
  // - キーボード: 行にフォーカスがあるとき、上下キー（Home・End も）で動かす。Delete で削除モードに入る。
  // 並びは onmove で親が決めて保存する。行の中身は row（snippet）で渡す。row の第 2 引数で削除モードと削除を受け取る

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
    /** 削除（削除モードの × から）。removable が true の項目だけ出す */
    onremove?: (id: string) => void;
    /** この項目を削除できるか（省くと削除モードでも × は出ない） */
    removable?: (item: T) => boolean;
    /** 行の中身。削除モードの状態と、削除の操作を受け取る */
    row: Snippet<[T, SortableRow]>;
    class?: string;
  } = $props();

  /** ドラッグの状態。from は動かす前の位置、slot は差し込み位置（行の前）、y はポインターの縦位置 */
  type Drag = { id: string; from: number; startY: number; y: number; slot: number };
  let drag = $state<Drag | null>(null);
  /** 持ち上げている行の拡大率（1 より少し大きく。行の高さは変えない） */
  const LIFT_SCALE = 1.02;
  /** 離したあと、並びを入れ替えるまでの間は、行の移動（CSS の transition）を止める */
  let settling = $state(false);
  /** 削除モード（リストの中の全部の行の操作部品が × に替わる） */
  let deleting = $state(false);
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
    /** 押したまま並べ替えの時間が過ぎた（タッチ） */
    held: boolean;
    mode: RowGesture | null;
    /** 並べ替えの時間（タッチ）と、削除モードに入る時間。どちらも動いたら取り消す */
    holdTimer: ReturnType<typeof setTimeout> | null;
    deleteTimer: ReturnType<typeof setTimeout> | null;
    body: HTMLElement;
  };
  let gesture: Gesture | null = null;

  /**
   * 途中の操作を取り消す（並びが外から変わった・ページを離れた）。
   * 押したまま待つ時間の計測も止める。並べ替えの途中の位置は捨てる（並びは変えない）
   */
  function cancelGesture() {
    const g = gesture;
    if (g) clearTimers(g);
    gesture = null;
    drag = null;
  }

  onDestroy(() => cancelGesture());

  /** 並べている項目の ID の並び。ドラッグの途中で変わったら、その操作は取り消す（位置がずれて別の項目を動かさないため） */
  let lastIds: string[] | null = null;
  $effect.pre(() => {
    const ids = items.map(getId);
    if (lastIds !== null && !sameIdOrder(lastIds, ids)) cancelGesture();
    lastIds = ids;
  });

  /**
   * 削除モードの間は、リストの外のタップ（と Escape）で終わる。
   * Escape は、削除モードを閉じたときだけ止める（ほかの画面の Escape の動作を妨げないため）
   */
  $effect(() => {
    if (!deleting) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !listEl?.contains(e.target)) deleting = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      deleting = false;
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
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
    // 持ち上げている行は、指に合わせて動かし、わずかに大きくする（ほかの行の位置は変えない）
    if (i === drag.from) return `translateY(${drag.y - drag.startY}px) scale(${LIFT_SCALE})`;
    if (!targets) return undefined;
    // 行の位置と並びの数がそろっていないときは動かさない（取り消しの直前の描画）
    const to = rowTops[targets[i]];
    const from = rowTops[i];
    if (!to || !from) return undefined;
    const d = to.top - from.top;
    return d === 0 ? undefined : `translateY(${d}px)`;
  }

  /** 押したところが、ボタン・入力欄などの操作部品の中か */
  function inControl(target: EventTarget | null, body: HTMLElement): boolean {
    if (!(target instanceof Element) || target === body) return false;
    return target.closest('button, input, select, textarea, a, label, [role="switch"], [contenteditable="true"]') !== null;
  }

  function canRemoveItem(item: T): boolean {
    return !!onremove && !!removable?.(item);
  }

  function clearTimers(g: Gesture) {
    if (g.holdTimer !== null) clearTimeout(g.holdTimer);
    if (g.deleteTimer !== null) clearTimeout(g.deleteTimer);
    g.holdTimer = null;
    g.deleteTimer = null;
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

  /** 削除モードに入る。短い振動で知らせる（対応していない環境では何もしない） */
  function enterDelete(g: Gesture) {
    if (gesture !== g || g.mode !== null) return;
    clearTimers(g);
    gesture = null;
    deleting = true;
    try {
      navigator.vibrate?.(12);
    } catch {
      // 振動に対応しない環境（デスクトップなど）
    }
  }

  function onRowDown(e: PointerEvent, i: number, item: T) {
    if (e.button !== 0 || !listEl) return;
    const body = e.currentTarget as HTMLElement;
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
      mode: null,
      holdTimer: null,
      deleteTimer: null,
      body,
    };
    gesture = g;
    if (e.pointerType === 'touch') {
      g.holdTimer = setTimeout(() => {
        g.holdTimer = null;
        if (gesture !== g || g.mode !== null) return;
        g.held = true;
      }, dragHoldMs(deleting));
    }
    // 削除モードの中では、もう入らない（並べ替えの押し方は短い時間で始まる）
    if (!deleting && onremove) {
      g.deleteTimer = setTimeout(() => {
        g.deleteTimer = null;
        enterDelete(g);
      }, DELETE_MODE_HOLD_MS);
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
      // 並べ替えにならない動き（ページのスクロール・横の動き）は、ここで手を離す
      if (next !== 'drag') {
        clearTimers(g);
        gesture = null;
        return;
      }
      clearTimers(g);
      startDrag(g, e.clientY);
    }
    if (g.mode === 'drag' && drag) {
      e.preventDefault();
      drag = { ...drag, y: e.clientY, slot: dropSlot(rowTops, e.clientY) };
    }
  }

  function onRowEnd(e: PointerEvent, cancelled: boolean) {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    clearTimers(g);
    gesture = null;
    if (g.mode !== 'drag') return;
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

  /**
   * 削除（削除モードの ×）。削除に使ったところにフォーカスがあったときは、近くの行へ移す
   * （消えた行の中では、フォーカスが body に落ちてキーボードの位置を失うため）
   */
  function remove(id: string) {
    const wasFocused = document.activeElement?.closest<HTMLElement>('[data-sortable-id]')?.dataset.sortableId === id;
    const idx = items.findIndex((x) => getId(x) === id);
    const next = idx < 0 ? undefined : (items[idx + 1] ?? items[idx - 1]);
    onremove?.(id);
    if (!wasFocused || !next) return;
    const nextId = getId(next);
    void tick().then(() => focusRow(nextId));
  }

  /** 行（並べ替えの行の body）にフォーカスを移す */
  function focusRow(id: string) {
    const moved = listEl?.querySelectorAll<HTMLElement>(':scope > [data-sortable-id]');
    const row = moved ? [...moved].find((el) => el.dataset.sortableId === id) : undefined;
    row?.querySelector<HTMLElement>('.sortable-list-body')?.focus();
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
    if (e.key === 'Delete' && onremove) {
      e.preventDefault();
      deleting = true;
      return;
    }
    const to = keyMoveTarget(e.key, i, items.length);
    if (to === null) return;
    e.preventDefault();
    const id = getId(items[i]);
    await commit(id, to);
    // 並びが変わると行の DOM が動くため、同じ行にフォーカスを戻す
    focusRow(id);
  }
</script>

<div
  class="sortable-list {className}"
  class:sortable-list-dragging={drag !== null}
  class:sortable-list-settling={settling}
  class:sortable-list-deleting={deleting}
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
      <!-- 行は、上下キーで動かせるフォーカスの対象（役割は group）。中の操作部品は、そのまま使える -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="sortable-list-body"
        role="group"
        tabindex="0"
        aria-label="{getLabel(item)} を並べ替える（上下キーで動かす）"
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
        {@render row(item, {
          deleting,
          canRemove: canRemoveItem(item),
          remove: () => remove(id),
        })}
      </div>
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
  /* 持ち上げた行は、影を付ける（行の大きさは変えない。影と拡大は transform で、ほかの行は動かさない） */
  .sortable-list-item-dragging {
    z-index: 1;
  }
  .sortable-list-item-dragging :global(.setting-row) {
    background: var(--surface);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow);
  }
  /* 行の大部分が当たり判定。縦はページのスクロールに任せ（タッチの並べ替えは長押しのあとだけ）、横の動きは何もしない */
  .sortable-list-body {
    flex: 1;
    min-width: 0;
    position: relative;
    cursor: grab;
    touch-action: pan-y;
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
  .sortable-list-body:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .sortable-list-item-dragging .sortable-list-body {
    cursor: grabbing;
  }
  @media (prefers-reduced-motion: reduce) {
    .sortable-list-item {
      transition: none;
    }
  }
</style>
