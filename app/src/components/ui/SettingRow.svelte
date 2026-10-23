<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // 設定の1行。左にアイコン（任意）・名前と説明、右に操作（control）を置く。
  // 見た目はグローバルの .setting-row（@3pino/design-system の components.css）。プラグイン向けの ui.setting も同じ DOM を作る
  // onclick を渡すと、行全体が1つの ghost ボタンになる（名前が読み上げの名前。control は飾りだけにする。中にボタンは置けない）
  let {
    name,
    description,
    descriptionBelow = false,
    icon,
    class: className = '',
    control,
    onclick,
  }: {
    name: string;
    description?: string;
    /** 説明が長いとき、名前と操作の下の別の段に出す（短い説明は従来どおり名前の下） */
    descriptionBelow?: boolean;
    /** 名前の左に出すアイコン（名前か Svelte の部品） */
    icon?: IconRef;
    class?: string;
    control?: Snippet;
    /** 行全体を押せるボタンにする。押したときに呼ばれる */
    onclick?: () => void;
  } = $props();
</script>

{#snippet content()}
  {#if icon}<Icon {icon} size={20} class="setting-row-icon" />{/if}
  <div class="setting-row-info">
    <div class="setting-row-name">{name}</div>
    {#if description && !descriptionBelow}<div class="setting-row-description">{description}</div>{/if}
  </div>
  {#if control}
    <div class="setting-row-control">{@render control()}</div>
  {/if}
  {#if description && descriptionBelow}<div class="setting-row-description setting-row-description-below">{description}</div>{/if}
{/snippet}

{#if onclick}
  <button type="button" class="setting-row setting-row-button {className}" class:setting-row-wrap={descriptionBelow && !!description} aria-label={name} {onclick}>
    {@render content()}
  </button>
{:else}
  <div class="setting-row {className}" class:setting-row-wrap={descriptionBelow && !!description}>
    {@render content()}
  </div>
{/if}

<style>
  /* 説明を下の段へ出す行。名前と操作は 1 段目、説明は幅いっぱいの 2 段目 */
  :global(.setting-row.setting-row-wrap) {
    flex-wrap: wrap;
    row-gap: var(--space-2);
  }
  :global(.setting-row-description-below) {
    flex: 0 0 100%;
    order: 1;
  }
</style>
