<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import type { MessageCard } from '../lib/protocol/MessageCard';
  import { pluginHost } from '../lib/plugins/host.svelte';

  // プラグインのセッションのカード。タップすると、そのプラグインの view でセッションを開く。
  // プラグインがない・オフのときは、標準の見た目で最後の内容を出し、開けないことが分かるようにする
  let { card }: { card: MessageCard } = $props();

  const view = $derived(pluginHost.cardView(card.plugin));
  const custom = $derived(pluginHost.hasCardRenderer(card.plugin));
  /** プラグインのアイコン（icon.svg → manifest.icon → puzzle）。オフでも、配布済みならそのアイコン */
  const icon = $derived(pluginHost.pluginIcon(card.plugin));
  /** 開けないときの説明 */
  const unavailable = $derived.by(() => {
    if (view) return null;
    if (!pluginHost.isEnabled(card.plugin)) return 'この端末ではオフになっているため開けません';
    if (!pluginHost.runtime(card.plugin)) return `プラグイン「${card.plugin}」がないため開けません`;
    return null;
  });

  let customEl: HTMLDivElement | undefined = $state();
  let customOk = $state(true);

  // プラグインの描画（registerCardRenderer）。カードが書き換わるたびに描き直す
  $effect(() => {
    const el = customEl;
    const data = { sessionId: card.session_id, title: card.title, text: card.text };
    if (!el || !custom) return;
    const r = pluginHost.runtime(card.plugin);
    el.replaceChildren();
    customOk = !!r && r.renderCard(el, data);
  });

  function open() {
    if (view) pluginHost.openCard(card);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    open();
  }
</script>

<!-- プラグインの描画の中にボタンなどが入ることがあるので、<button> ではなく role="button" にする -->
<div
  class="message-card"
  class:message-card-openable={!!view}
  class:message-card-unavailable={!view}
  data-plugin={card.plugin}
  data-session={card.session_id}
  role="button"
  tabindex={view ? 0 : -1}
  aria-disabled={view ? undefined : 'true'}
  onclick={open}
  {onkeydown}
>
  <div class="message-card-custom" hidden={!custom || !customOk} bind:this={customEl}></div>
  {#if !custom || !customOk}
    <div class="message-card-header">
      <Icon {icon} size={14} />
      <span class="message-card-title">{card.title}</span>
    </div>
    {#if card.text}<div class="message-card-text">{card.text}</div>{/if}
  {/if}
  {#if unavailable}<div class="message-card-unavailable-note">{unavailable}</div>{/if}
</div>

<style>
  .message-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 420px;
    margin-top: 2px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    -webkit-user-select: none;
    user-select: none;
  }
  .message-card.message-card-openable {
    cursor: pointer;
  }
  .message-card.message-card-openable:hover {
    border-color: var(--border-hover);
  }
  .message-card.message-card-openable:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 1px;
  }
  .message-card.message-card-unavailable {
    border-style: dashed;
  }
  .message-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text-muted);
    font-size: 12px;
  }
  .message-card-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .message-card-text {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .message-card-unavailable-note {
    margin-top: 2px;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
