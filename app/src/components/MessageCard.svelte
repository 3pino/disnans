<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import Avatar from './Avatar.svelte';
  import type { MessageCard } from '../lib/protocol/MessageCard';
  import { pluginHost } from '../lib/plugins/host.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { presence } from '../lib/stores/presence.svelte';

  /** 開いている人を並べる上限（残りは +n） */
  const VIEWERS_SHOWN = 5;

  // プラグインのセッションのカード。タップすると、そのプラグインの view でセッションを開く。
  // プラグインがない・オフのときは、標準の見た目で最後の内容を出し、開けないことが分かるようにする
  let { card }: { card: MessageCard } = $props();

  const view = $derived(pluginHost.cardView(card.plugin));
  const custom = $derived(pluginHost.hasCardRenderer(card.plugin));
  /** プラグインのアイコン（icon.svg → manifest.icon → puzzle）。オフでも、配布済みならそのアイコン */
  const icon = $derived(pluginHost.pluginIcon(card.plugin));
  /** このセッションを開いている人（プレゼンス。自分を含む） */
  const viewers = $derived(presence.viewers(card.session_id));
  const viewersShown = $derived(viewers.slice(0, VIEWERS_SHOWN));
  const viewersTitle = $derived(viewers.map((id) => client.nameOf(id)).join('、'));
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
  {#if viewers.length > 0}
    <div class="message-card-viewers" title="開いている人: {viewersTitle}">
      {#each viewersShown as id (id)}
        <Avatar user={client.user(id)} {id} size={18} />
      {/each}
      {#if viewers.length > viewersShown.length}<span class="message-card-viewers-more">+{viewers.length - viewersShown.length}</span>{/if}
    </div>
  {/if}
  {#if unavailable}<div class="message-card-unavailable-note">{unavailable}</div>{/if}
</div>

<style>
  .message-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 420px;
    margin-top: var(--space-1);
    padding: var(--space-4) var(--space-6);
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
    gap: var(--space-3);
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .message-card-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--fw-semibold);
  }
  .message-card-text {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .message-card-viewers {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-top: var(--space-1);
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .message-card-viewers-more {
    margin-left: var(--space-1);
  }
  .message-card-unavailable-note {
    margin-top: var(--space-1);
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
</style>
