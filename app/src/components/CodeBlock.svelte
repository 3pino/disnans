<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import { copyText } from '../lib/clipboard';
  import { ui } from '../lib/stores/ui.svelte';

  // 本文のコードブロック。右上にコピーのボタンを出す
  // （マウスでは重ねたときだけ。タッチの端末ではいつも薄く出す）
  let { text, lang }: { text: string; lang: string } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    if (!(await copyText(text))) {
      ui.toast('コピーできませんでした', 'error');
      return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }

  $effect(() => () => clearTimeout(timer));
</script>

<div class="code-block" class:code-block-copied={copied}>
  <pre><code data-lang={lang || undefined}>{text}</code></pre>
  <button type="button" class="code-block-copy" aria-label={copied ? 'コピーしました' : 'コードをコピー'} title={copied ? 'コピーしました' : 'コピー'} onclick={copy}>
    {#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
  </button>
  <span class="sr-only" aria-live="polite">{copied ? 'コピーしました' : ''}</span>
</div>

<style>
  .code-block {
    position: relative;
    min-width: 0;
  }
  /* 1行目の右端がボタンに隠れないように空ける */
  .code-block pre {
    padding-right: 40px;
  }
  .code-block-copy {
    position: absolute;
    top: 5px;
    right: 5px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    opacity: 0;
    transition:
      opacity 0.12s,
      color 0.12s;
  }
  .code-block-copy:hover {
    color: var(--text);
  }
  /* マウスでは、コードブロックに重ねたときやキーボードで選んだときだけ出す */
  .code-block:hover .code-block-copy,
  .code-block-copy:focus-visible {
    opacity: 1;
  }
  /* タッチの端末は重ねられないので、いつも薄く出しておく */
  @media (hover: none) {
    .code-block .code-block-copy {
      opacity: 0.7;
    }
  }
  .code-block.code-block-copied .code-block-copy {
    color: var(--success);
    opacity: 1;
  }
</style>
