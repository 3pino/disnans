<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import X from '@lucide/svelte/icons/x';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import IconButton from './ui/IconButton.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { pluginHost } from '../lib/plugins/host.svelte';
  import type { ViewHandle } from '../lib/plugins/runtime';

  // プラグインの view を出すパネル（枠は ThreadPanel と同じ）。view は containerEl に自分で描く
  let { plugin, view, sessionId }: { plugin: string; view: string; sessionId: string } = $props();

  const runtime = $derived(pluginHost.runtime(plugin));
  let containerEl: HTMLDivElement | undefined = $state();
  let viewTitle = $state<string | null>(null);
  let error = $state<string | null>(null);
  let opening = $state(true);

  const title = $derived(viewTitle ?? runtime?.manifest.name ?? plugin);

  $effect(() => {
    const r = runtime;
    const el = containerEl;
    const v = view;
    const sid = sessionId;
    if (!el) return;
    if (!r) {
      opening = false;
      error = 'プラグインが読み込まれていないため、開けません。';
      return;
    }
    let handle: ViewHandle | null = null;
    let cancelled = false;
    opening = true;
    error = null;
    viewTitle = null;
    el.replaceChildren();
    r.mountView(v, sid, el).then(
      (h) => {
        if (cancelled) {
          h.close();
          return;
        }
        handle = h;
        viewTitle = h.view.title ?? null;
        opening = false;
      },
      (e: unknown) => {
        if (cancelled) return;
        console.error(`[plugin:${r.id}] view を開けませんでした`, e);
        error = `開けませんでした: ${e instanceof Error ? e.message : String(e)}`;
        opening = false;
      },
    );
    return () => {
      cancelled = true;
      handle?.close();
      el.replaceChildren();
    };
  });
</script>

<div id="plugin-panel" class="plugin-panel" data-plugin={plugin}>
  <header class="plugin-panel-header">
    {#if ui.isMobile}
      <!-- モバイルは戻るボタンと題名 -->
      <IconButton class="plugin-panel-back" label="戻る" onclick={() => ui.closePanel()}><ArrowLeft size={20} /></IconButton>
      <div class="plugin-panel-title"><span class="plugin-panel-title-text">{title}</span></div>
    {:else}
      <div class="plugin-panel-title">
        <Puzzle size={16} />
        <span class="plugin-panel-title-text">{title}</span>
      </div>
      <IconButton class="plugin-panel-close" label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></IconButton>
    {/if}
  </header>

  {#if error}
    <div class="plugin-panel-status muted">{error}</div>
  {:else if opening}
    <div class="plugin-panel-status muted">読み込み中…</div>
  {/if}
  <div class="scroll plugin-panel-body" bind:this={containerEl}></div>
</div>

<style>
  .plugin-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .plugin-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 52px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .plugin-panel-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 650;
  }
  .plugin-panel-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plugin-panel-body {
    flex: 1;
    min-height: 0;
  }
  .plugin-panel-status {
    padding: 32px 16px;
    text-align: center;
  }
  @media (max-width: 767px) {
    .plugin-panel-header {
      padding: calc(env(safe-area-inset-top) + 4px) 8px 4px 4px;
      height: auto;
      border-bottom: none;
    }
    .plugin-panel-header > :global(.plugin-panel-back) {
      width: 40px;
      height: 40px;
    }
  }
</style>
