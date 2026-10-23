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

  // メッセージの集合を、本体のメッセージ表示（MessageItem）のまま出すパネル（枠は返信のツリーと同じ）。
  // 返信のツリーと、プラグインの openTimeline が使う。深さ（depth）があれば、その分だけ字下げして線で結ぶ
  // id: timelinePanels のパネル（プラグインの openTimeline）。tree: 返信のツリー（中身はその場で作る）
  let { id, tree }: { id?: number; tree?: { messageId: string } } = $props();

  const spec = $derived(id !== undefined ? timelinePanels.get(id) : tree ? timelinePanels.replyTreeSpec(tree.messageId) : undefined);
  const entries = $derived(spec?.entries() ?? []);

  /** 字下げする深さの上限（これより深いものは同じ位置に並べる。狭い画面で本文が潰れないように） */
  const MAX_INDENT = 6;
  /** 1段ぶんの字下げ（px） */
  const INDENT_PX = 14;

  // パネルが外れたら（閉じた・別のパネルに替わった）後片付けする
  onMount(() => {
    const mine = id;
    return () => {
      if (mine !== undefined) timelinePanels.release(mine);
    };
  });
</script>

<div class="timeline-panel">
  <header class="timeline-panel-header">
    {#if ui.isMobile}
      <IconButton class="timeline-panel-back" label="戻る" onclick={() => ui.back()}><ArrowLeft size={20} /></IconButton>
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
    gap: var(--space-3);
    height: 52px;
    padding: 0 var(--space-4) 0 var(--space-7);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .timeline-panel-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    font-weight: var(--fw-semibold);
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
    padding: var(--space-4) 0;
  }
  /* 返信は、親の下に線でつなぐ */
  .timeline-panel-row-nested {
    border-left: 2px solid var(--border);
  }
  .timeline-panel-empty {
    padding: 32px var(--space-7);
    text-align: center;
  }
  @media (max-width: 767px) {
    .timeline-panel-header {
      padding: var(--space-2) var(--space-4) var(--space-2) var(--space-2);
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
