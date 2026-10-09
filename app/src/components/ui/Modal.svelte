<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';

  // モーダルダイアログ。見た目はグローバルの .modal（app.css）
  let { title, onclose, children, width = 420 }: { title: string; onclose: () => void; children: Snippet; width?: number } =
    $props();
  let box: HTMLDivElement | undefined = $state();

  onMount(() => {
    const prev = document.activeElement as HTMLElement | null;
    box?.querySelector<HTMLElement>('input, button.primary, button')?.focus();
    return () => prev?.focus?.();
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="modal-scrim" role="presentation" onclick={onclose}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label={title} bind:this={box} style:--modal-w="{width}px">
  <h2 class="modal-title">{title}</h2>
  {@render children()}
</div>
