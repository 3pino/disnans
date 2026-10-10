<script lang="ts">
  import { pluginHost } from '../lib/plugins/host.svelte';

  /** プラグインが addStatusBarItem で作った要素を、そのまま枠に入れる */
  function mount(node: HTMLElement, el: HTMLElement) {
    node.append(el);
    return {
      destroy() {
        el.remove();
      },
    };
  }
</script>

{#if pluginHost.statusItems.length > 0}
  <div class="plugin-status-bar" role="region" aria-label="プラグインのステータス">
    {#each pluginHost.statusItems as item (item.el)}
      <div class="plugin-status-item" data-plugin={item.pluginId} use:mount={item.el}></div>
    {/each}
  </div>
{/if}

<style>
  .plugin-status-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex: none;
  }
  .plugin-status-item {
    min-width: 0;
  }
  /* 中身のない項目と、項目がすべて空の帯は出さない */
  .plugin-status-item:has(> :global(:empty)) {
    display: none;
  }
  .plugin-status-bar:not(:has(.plugin-status-item > :global(:not(:empty)))) {
    display: none;
  }
</style>
