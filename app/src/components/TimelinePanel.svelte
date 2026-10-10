<script lang="ts">
  import { onMount } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import X from '@lucide/svelte/icons/x';
  import MessagesSquare from '@lucide/svelte/icons/messages-square';
  import MessageItem from './MessageItem.svelte';
  import IconButton from './ui/IconButton.svelte';
  import Icon from './ui/Icon.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { timelinePanels } from '../lib/stores/timelinePanel.svelte';

  // メッセージの集合を、本体のメッセージ表示（MessageItem）のまま出すパネル（枠は ThreadPanel と同じ）。
  // 返信のツリーと、プラグインの openTimeline が使う。深さ（depth）があれば、その分だけ字下げして線で結ぶ
  let { id }: { id: number } = $props();

  const spec = $derived(timelinePanels.get(id));
  const entries = $derived(spec?.entries() ?? []);

  /** 字下げする深さの上限（これより深いものは同じ位置に並べる。狭い画面で本文が潰れないように） */
  const MAX_INDENT = 6;
  /** 1段ぶんの字下げ（px） */
  const INDENT_PX = 14;

  // パネルが外れたら（閉じた・別のパネルに替わった）後片付けする
  onMount(() => () => timelinePanels.release(id));
</script>

<div class="timeline-panel">
  <header class="timeline-panel-header">
    {#if ui.isMobile}
      <IconButton class="timeline-panel-back" label="戻る" onclick={() => ui.closePanel()}><ArrowLeft size={20} /></IconButton>
      <div class="timeline-panel-title timeline-panel-title-mobile">{spec?.title ?? ''}</div>
    {:else}
      <div class="timeline-panel-title">
        <Icon icon={spec?.icon ?? MessagesSquare} size={16} />
        <span>{spec?.title ?? ''}</span>
      </div>
      <IconButton class="timeline-panel-close" label="閉じる" onclick={() => ui.closePanel()}><X size={18} /></IconButton>
    {/if}
  </header>

  <div class="timeline-panel-list">
    {#each entries as e (e.message.id)}
      {@const depth = Math.min(e.depth, MAX_INDENT)}
      <div class="timeline-panel-row" class:timeline-panel-row-nested={depth > 0} style:margin-left="{depth * INDENT_PX}px">
        <MessageItem message={e.message} />
      </div>
    {:else}
      <div class="timeline-panel-empty muted">{spec?.empty ?? 'メッセージはありません。'}</div>
    {/each}
  </div>
</div>

<style>
  .timeline-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
  }
  .timeline-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 52px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .timeline-panel-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 650;
  }
  .timeline-panel-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .timeline-panel-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 0;
  }
  /* 返信は、親の下に線でつなぐ */
  .timeline-panel-row-nested {
    border-left: 2px solid var(--border);
  }
  .timeline-panel-empty {
    padding: 32px 16px;
    text-align: center;
  }
  @media (max-width: 767px) {
    .timeline-panel-header {
      padding: calc(env(safe-area-inset-top) + 4px) 8px 4px 4px;
      height: auto;
      border-bottom: none;
    }
    .timeline-panel-header > :global(.timeline-panel-back) {
      width: 40px;
      height: 40px;
    }
    .timeline-panel-title-mobile {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
