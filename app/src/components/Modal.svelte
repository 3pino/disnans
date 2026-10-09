<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';

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
<div class="modal" role="dialog" aria-modal="true" aria-label={title} bind:this={box} style:--w="{width}px">
  <h2 class="modal-title">{title}</h2>
  {@render children()}
</div>

<style>
  .modal-scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: oklch(0.08 0.01 248 / 0.5);
    animation: fade 0.15s;
  }
  .modal {
    position: fixed;
    z-index: 81;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(var(--w), calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    overflow-y: auto;
    padding: 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    animation: pop 0.15s ease-out;
  }
  .modal-title {
    margin: 0 0 14px;
    font-size: 17px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, -48%);
    }
  }
</style>
