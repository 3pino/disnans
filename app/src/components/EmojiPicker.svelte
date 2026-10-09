<script lang="ts">
  import { onMount } from 'svelte';
  import { EMOJI_SET } from '../lib/emoji';

  let {
    anchor,
    onpick,
    onclose,
  }: { anchor: DOMRect; onpick: (emoji: string) => void; onclose: () => void } = $props();

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ top: 0, left: 0 });

  onMount(() => {
    const w = el?.offsetWidth ?? 280;
    const h = el?.offsetHeight ?? 220;
    const margin = 8;
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, anchor.top - h - 6);
    let left = anchor.right - w;
    left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
    pos = { top, left };
    el?.querySelector<HTMLButtonElement>('button')?.focus();

    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onclose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onclose();
    };
    // 開いたクリック自体で閉じないよう、次のタスクで登録する
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true));
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onclose);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onclose);
    };
  });
</script>

<div class="picker" bind:this={el} style:top="{pos.top}px" style:left="{pos.left}px" role="dialog" aria-label="リアクションを選ぶ">
  {#each EMOJI_SET as e (e)}
    <button type="button" onclick={() => onpick(e)} aria-label={e}>{e}</button>
  {/each}
</div>

<style>
  .picker {
    position: fixed;
    z-index: 50;
    display: grid;
    grid-template-columns: repeat(6, 40px);
    gap: 2px;
    padding: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  button {
    width: 40px;
    height: 38px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: 22px;
    line-height: 1;
  }
  button:hover,
  button:focus-visible {
    background: var(--surface-2);
    outline: none;
  }
</style>
