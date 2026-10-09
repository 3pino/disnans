<script lang="ts">
  import type { Snippet } from 'svelte';
  import { parse, type Block } from '../lib/markdown';
  import InlineNodes from './InlineNodes.svelte';

  // suffix: 末尾に添える要素（「編集済み」など）。最後が段落ならその行内に置く
  let { body, suffix }: { body: string; suffix?: Snippet } = $props();
  const blocks = $derived(parse(body));
  const inlineSuffix = $derived(blocks.at(-1)?.type === 'paragraph');
</script>

{#snippet render(list: Block[], top = false)}
  {#each list as b, i (i)}
    {#if b.type === 'paragraph'}
      <p>
        {#each b.lines as line, j (j)}{#if j > 0}<br />{/if}<InlineNodes nodes={line} />{/each}{#if top && suffix && i === list.length - 1}{' '}{@render suffix()}{/if}
      </p>
    {:else if b.type === 'code'}
      <pre><code data-lang={b.lang || undefined}>{b.text}</code></pre>
    {:else if b.type === 'quote'}
      <blockquote>{@render render(b.children)}</blockquote>
    {:else if b.type === 'list'}
      {#if b.ordered}
        <ol start={b.start}>
          {#each b.items as item, j (j)}<li><InlineNodes nodes={item} /></li>{/each}
        </ol>
      {:else}
        <ul>
          {#each b.items as item, j (j)}<li><InlineNodes nodes={item} /></li>{/each}
        </ul>
      {/if}
    {/if}
  {/each}
{/snippet}

<div class="markdown-body">
  {@render render(blocks, true)}{#if suffix && !inlineSuffix}<div>{@render suffix()}</div>{/if}
</div>

<style>
  .markdown-body {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol),
  .markdown-body :global(pre),
  .markdown-body :global(blockquote) {
    margin: 0;
  }
  .markdown-body > :global(* + *),
  .markdown-body :global(blockquote > * + *) {
    margin-top: 0.4em;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.5em;
  }
  .markdown-body :global(li::marker) {
    color: var(--text-muted);
  }
  .markdown-body :global(pre) {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre;
    scrollbar-width: thin;
  }
  .markdown-body :global(blockquote) {
    padding: 1px 0 1px 12px;
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }
</style>
