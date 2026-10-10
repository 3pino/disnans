<script lang="ts">
  import { tick } from 'svelte';
  import Plus from '@lucide/svelte/icons/plus';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import X from '@lucide/svelte/icons/x';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import MenuItem from './ui/MenuItem.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import Toggle from './ui/Toggle.svelte';
  import {
    addComposerMenuCommand,
    composerMenuAvailable,
    composerMenuItems,
    dropSlot,
    removeComposerMenuEntry,
    reorderComposerMenuEntry,
    setComposerMenuHidden,
    slotToIndex,
  } from '../lib/composerMenu';
  import { prefs } from '../lib/stores/prefs.svelte';

  // 設定の「＋メニュー」: 入力欄の「＋」を押したときに出す項目を、並べ替え・表示の切り替え・コマンドの追加で決める。
  // 並べ替えは左のつまみをドラッグする（マウスもタッチも、ポインターイベントで行う）。つまみにフォーカスして上下キーでも動かせる。
  // 保存はサーバー（prefs）で、同じユーザーの端末で共有する。削除したプラグインの項目は、出ないだけで設定には残る

  let pickerOpen = $state(false);
  let listEl: HTMLElement | undefined = $state();
  /** 本体・プラグインの操作・コマンド（設定では「出す・出さないにかかわらず全部見せる」） */
  const available = $derived(composerMenuAvailable(() => {}));
  /** 並べている項目（出さないものも含む）。表示の順 */
  const items = $derived(composerMenuItems(available, prefs.composerMenu, { includeHidden: true }));
  /** まだ並べていないコマンド */
  const addable = $derived(available.filter((a) => a.kind === 'command' && !items.some((x) => x.entry.id === a.id)));

  /** ドラッグ中の状態。from は動かす前の位置、slot は差し込み位置（行の前）、y はポインターの縦位置、lineTop は差し込み線の位置 */
  let drag = $state<{ id: string; from: number; startY: number; y: number; slot: number; lineTop: number } | null>(null);
  /** ドラッグを始めたときの行の位置（画面の座標）と、並びの親の上端。ドラッグ中は変えない */
  let rowRects: { top: number; bottom: number }[] = [];
  let listTop = 0;

  /** 差し込み線が出るか（動かさないときの位置には出さない） */
  const showLine = $derived(drag !== null && drag.slot !== drag.from && drag.slot !== drag.from + 1);

  function lineTopFor(slot: number): number {
    if (rowRects.length === 0) return 0;
    const y = slot < rowRects.length ? rowRects[slot].top : rowRects[rowRects.length - 1].bottom;
    return y - listTop;
  }

  function reorder(id: string, toIndex: number) {
    prefs.setComposerMenu(reorderComposerMenuEntry(prefs.composerMenu, available, id, toIndex));
  }

  function setShown(id: string, shown: boolean) {
    prefs.setComposerMenu(setComposerMenuHidden(prefs.composerMenu, id, !shown));
  }

  function remove(id: string) {
    prefs.setComposerMenu(removeComposerMenuEntry(prefs.composerMenu, id));
  }

  function add(id: string) {
    pickerOpen = false;
    prefs.setComposerMenu(addComposerMenuCommand(prefs.composerMenu, available, id));
  }

  function onGripDown(e: PointerEvent, id: string, i: number) {
    if (e.button !== 0 || !listEl) return;
    const grip = e.currentTarget as HTMLElement;
    // 指を離すまで、動きをこのつまみで受ける（マウスが外に出ても続く）
    grip.setPointerCapture(e.pointerId);
    listTop = listEl.getBoundingClientRect().top;
    rowRects = [...listEl.querySelectorAll<HTMLElement>(':scope > [data-id]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    drag = { id, from: i, startY: e.clientY, y: e.clientY, slot: i, lineTop: lineTopFor(i) };
  }

  function onGripMove(e: PointerEvent) {
    if (!drag) return;
    // つまみの touch-action: none と合わせて、ドラッグ中はページを動かさない
    e.preventDefault();
    const slot = dropSlot(rowRects, e.clientY);
    drag = { ...drag, y: e.clientY, slot, lineTop: lineTopFor(slot) };
  }

  function onGripUp() {
    if (!drag) return;
    const { id, from, slot } = drag;
    drag = null;
    const to = slotToIndex(from, slot);
    if (to !== from) reorder(id, to);
  }

  function cancelDrag() {
    drag = null;
  }

  function onGripKey(e: KeyboardEvent, id: string, i: number) {
    let to: number;
    if (e.key === 'ArrowUp') to = i - 1;
    else if (e.key === 'ArrowDown') to = i + 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else return;
    e.preventDefault();
    reorder(id, to);
    // 並びが変わると行の DOM が動くため、同じつまみにフォーカスを戻す
    void tick().then(() => {
      listEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .composer-menu-settings-grip`)?.focus();
    });
  }
</script>

<Section title="＋メニュー" class="composer-menu-settings">
  <p class="muted composer-menu-settings-note">
    入力欄の「＋」を押したときに出す項目です。左のつまみをドラッグして並べ替えられます（つまみにフォーカスして上下キーでも動かせます）。
    出さない項目は右の切り替えで外し、追加したコマンドは × で外します。この設定はほかの端末とも共有されます
  </p>

  <div class="composer-menu-settings-list" bind:this={listEl} class:composer-menu-settings-dragging={drag !== null}>
    {#each items as x, i (x.entry.id)}
      <div
        class="composer-menu-settings-item"
        class:composer-menu-settings-item-dragging={drag?.id === x.entry.id}
        data-id={x.entry.id}
        style:transform={drag?.id === x.entry.id ? `translateY(${drag.y - drag.startY}px)` : undefined}
      >
        <button
          type="button"
          class="composer-menu-settings-grip"
          aria-label="{x.entry.label} を並べ替える（上下キーで動かす）"
          onpointerdown={(e) => onGripDown(e, x.entry.id, i)}
          onpointermove={onGripMove}
          onpointerup={onGripUp}
          onpointercancel={cancelDrag}
          onlostpointercapture={cancelDrag}
          onkeydown={(e) => onGripKey(e, x.entry.id, i)}
        >
          <GripVertical size={16} />
        </button>
        <SettingRow
          name={x.entry.label}
          description={x.entry.source ?? (x.entry.kind === 'command' ? 'コマンド' : '本体')}
          icon={x.entry.icon ?? Puzzle}
          class="composer-menu-settings-row"
        >
          {#snippet control()}
            {#if x.entry.kind === 'command'}
              <IconButton label="{x.entry.label} をメニューから外す" class="composer-menu-settings-remove" onclick={() => remove(x.entry.id)}>
                <X size={16} />
              </IconButton>
            {:else}
              <Toggle checked={!x.hidden} label="{x.entry.label} を「＋」メニューに出す" onchange={(on) => setShown(x.entry.id, on)} />
            {/if}
          {/snippet}
        </SettingRow>
      </div>
    {/each}
    {#if showLine && drag}
      <div class="composer-menu-settings-drop" style:top="{drag.lineTop}px" aria-hidden="true"></div>
    {/if}
  </div>

  <span class="composer-menu-settings-add">
    <Button icon={Plus} aria-haspopup="menu" aria-expanded={pickerOpen} onclick={() => (pickerOpen = !pickerOpen)}>コマンドを追加</Button>
    {#if pickerOpen}
      <Menu class="composer-menu-settings-picker" label="追加するコマンド" onclose={() => (pickerOpen = false)}>
        {#each addable as c (c.id)}
          <MenuItem class="composer-menu-settings-pick" icon={c.icon ?? Puzzle} onclick={() => add(c.id)}>
            {c.label}{#if c.source}<span class="muted composer-menu-settings-source"> · {c.source}</span>{/if}
          </MenuItem>
        {:else}
          <p class="muted composer-menu-settings-none">追加できるコマンドはありません</p>
        {/each}
      </Menu>
    {/if}
  </span>
</Section>

<style>
  .composer-menu-settings-note {
    margin: 0;
    font-size: 13px;
  }
  .composer-menu-settings-list {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* ドラッグの間は文字を選べないようにする */
  .composer-menu-settings-dragging {
    user-select: none;
  }
  .composer-menu-settings-item {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: var(--radius-sm);
  }
  .composer-menu-settings-item-dragging {
    position: relative;
    z-index: 1;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .composer-menu-settings-grip {
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
  .composer-menu-settings-grip:hover {
    background: var(--hover);
    color: var(--text);
  }
  .composer-menu-settings-grip:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
  .composer-menu-settings-item-dragging .composer-menu-settings-grip {
    cursor: grabbing;
  }
  .composer-menu-settings-item > :global(.composer-menu-settings-row) {
    flex: 1;
    min-width: 0;
  }
  /* 差し込み位置を示す線 */
  .composer-menu-settings-drop {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    margin-top: -2px;
    border-radius: 1px;
    background: var(--accent);
    pointer-events: none;
  }
  .composer-menu-settings-add {
    position: relative;
    display: inline-flex;
    align-self: flex-start;
  }
  .composer-menu-settings-add > :global(.composer-menu-settings-picker) {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    /* 外側を閉じる幕（.menu-backdrop, z-index 29）より前に出す。小さい値にすると幕がメニューを覆い、項目が押せなくなる */
    z-index: 30;
    min-width: 240px;
    max-height: 320px;
    overflow-y: auto;
  }
  .composer-menu-settings-source {
    font-size: 12px;
  }
  .composer-menu-settings-none {
    margin: 0;
    padding: 8px 10px;
    font-size: 13px;
  }
</style>
