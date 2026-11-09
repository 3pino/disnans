<script lang="ts">
  import type { Snippet } from 'svelte';
  import { treeOf, type Block, type Inline, type ListItem } from '../lib/markdown';
  import { embedRowSegments } from '../lib/embedRow';
  import { fileLinkView } from '../lib/fileLink';
  import { sharedIndex } from '../lib/stores/sharedIndex.svelte';
  import InlineNodes from './InlineNodes.svelte';
  import CodeBlock from './CodeBlock.svelte';

  // markdown: Rust が作った木（あれば使う。無ければ body を TS で parse する）
  // suffix: 末尾に添える要素（「編集済み」など）。最後が段落ならその行内に置く
  let { body, markdown, suffix }: { body: string; markdown?: unknown; suffix?: Snippet } = $props();
  const blocks = $derived(treeOf(body, markdown));
  const inlineSuffix = $derived(blocks.at(-1)?.type === 'paragraph');

  // 画像の埋め込み（一覧で画像と分かったもの）だけ、続くものを横一列にする。カードなどは今までどおり。
  // 判断は FileLink と同じ（fileLinkView）。削除の印は画像かどうかに関わらないので渡さない
  const NO_DELETED: ReadonlySet<string> = new Set();
  function isImageEmbed(n: Inline): boolean {
    if (n.type !== 'fileLink' || !n.embed) return false;
    return fileLinkView({ path: n.path, alias: n.alias, embed: true }, sharedIndex.file(n.path), NO_DELETED).kind === 'embedImage';
  }
</script>

{#snippet render(list: Block[], top = false)}
  {#each list as b, i (i)}
    {#if b.type === 'paragraph'}
      <p>
        {#each embedRowSegments(b.lines, isImageEmbed) as seg, j (j)}{#if seg.kind === 'row'}<span class="embed-row">{#each seg.items as item, k (k)}<InlineNodes nodes={[item]} />{/each}</span>{:else if seg.kind === 'break'}<br />{:else}<InlineNodes nodes={seg.nodes} />{/if}{/each}{#if top && suffix && i === list.length - 1}{' '}{@render suffix()}{/if}
      </p>
    {:else if b.type === 'code'}
      <CodeBlock text={b.text} lang={b.lang} />
    {:else if b.type === 'quote'}
      <blockquote>{@render render(b.children)}</blockquote>
    {:else if b.type === 'list'}
      {#if b.ordered}
        <ol start={b.start}>
          {#each b.items as item, j (j)}{@render listItem(item)}{/each}
        </ol>
      {:else}
        <ul>
          {#each b.items as item, j (j)}{@render listItem(item)}{/each}
        </ul>
      {/if}
    {/if}
  {/each}
{/snippet}

{#snippet listItem(item: ListItem)}
  <li>{#each item.lines as line, k (k)}{#if k > 0}<br />{/if}<InlineNodes nodes={line} />{/each}{#if item.children.length > 0}{@render render(item.children)}{/if}</li>
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
  .markdown-body :global(li > * + *) {
    margin-top: 0.2em;
  }
  .markdown-body :global(pre) {
    padding: var(--space-5) var(--space-6);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: var(--fs-sm);
    line-height: var(--lh-body);
    white-space: pre;
    scrollbar-width: thin;
  }
  .markdown-body :global(blockquote) {
    padding: 1px 0 1px var(--space-6);
    border-left: 3px solid var(--border);
    color: var(--text-muted);
  }
  /* 続く画像の埋め込みの横一列。幅は段落の幅に収め、はみ出した分は列の中で横にスクロールする（縦のなぞりは奪わない） */
  .markdown-body .embed-row {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: var(--space-3);
    width: 100%;
    min-width: 0;
    margin: var(--space-2) 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x pan-y;
  }
  .markdown-body .embed-row > :global(*) {
    flex: none;
  }
  /* 横一列の画像は高さをそろえる（テーマの変数 --chat-image-row-height。上限は --chat-image-max-height）。幅は元の比のまま */
  .markdown-body .embed-row :global(.file-link-embed-image) {
    max-width: none;
  }
  .markdown-body .embed-row :global(.file-link-embed-image-img) {
    max-width: none;
    max-height: none;
    width: auto;
    height: min(var(--chat-image-row-height), var(--chat-image-max-height));
  }
</style>
