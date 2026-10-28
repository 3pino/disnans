<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { ui } from '../lib/stores/ui.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast" class:toast-error={t.kind === 'error'}>
      {#if t.avatar}
        <span class="toast-avatar">
          <AuthorAvatar author={t.avatar.author} user={t.avatar.user} id={t.avatar.id} size={28} />
        </span>
      {/if}
      <span class="toast-text">{t.text}</span>
      {#if t.action}
        {@const action = t.action}
        <button
          type="button"
          class="toast-action"
          onclick={() => {
            action.run();
            ui.dismiss(t.id);
          }}>{action.label}</button
        >
      {/if}
      <IconButton class="toast-close" label="閉じる" onclick={() => ui.dismiss(t.id)}><X size={14} /></IconButton>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    /* 操作ボタンが上端のバーを塞がないよう、その下に置く */
    top: calc(env(safe-area-inset-top) + 56px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 90;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    width: min(440px, calc(100vw - 24px));
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3) var(--space-4) 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    font-size: var(--fs-base);
    /* 通知の本体は押せない（上の ≡ などを覆わない）。押せるのは中のボタン（操作・閉じる）だけ */
    pointer-events: none;
    animation: drop 0.18s ease-out;
  }
  .toast :global(button) {
    pointer-events: auto;
  }
  /* 種類の見分けは error だけ（info には帯を付けない） */
  .toast.toast-error {
    border-left: 3px solid var(--danger);
  }
  .toast-avatar {
    flex: none;
    display: flex;
  }
  .toast-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .toast-action {
    border: none;
    background: none;
    color: var(--accent);
    font-weight: var(--fw-semibold);
  }
  .toast > :global(.toast-close) {
    width: 26px;
    height: 26px;
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
</style>
