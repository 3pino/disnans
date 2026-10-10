<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // 設定の1行。左にアイコン（任意）・名前と説明、右に操作（control）を置く。
  // 見た目はグローバルの .setting-row（app.css）。プラグイン向けの ui.setting も同じ DOM を作る
  // onclick を渡すと、行全体が1つの ghost ボタンになる（名前が読み上げの名前。control は飾りだけにする。中にボタンは置けない）
  let {
    name,
    description,
    icon,
    class: className = '',
    control,
    onclick,
  }: {
    name: string;
    description?: string;
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
    {#if description}<div class="setting-row-description">{description}</div>{/if}
  </div>
  {#if control}
    <div class="setting-row-control">{@render control()}</div>
  {/if}
{/snippet}

{#if onclick}
  <button type="button" class="setting-row setting-row-button {className}" aria-label={name} {onclick}>
    {@render content()}
  </button>
{:else}
  <div class="setting-row {className}">
    {@render content()}
  </div>
{/if}
