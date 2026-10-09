<script lang="ts" generics="T extends string">
  import Icon from './Icon.svelte';
  import type { IconRef } from '../../lib/icons.svelte';

  // 横に並んだ選択肢から1つを選ぶボタン（テーマの切り替えなど）。
  // 見た目はグローバルの .segmented（app.css）。プラグイン向けの ui.segmented も同じ DOM を作る
  let {
    options,
    value = $bindable(),
    label,
    class: className = '',
    onchange,
  }: {
    options: { value: T; label: string; icon?: IconRef }[];
    value: T;
    /** 読み上げ用の名前 */
    label?: string;
    class?: string;
    onchange?: (value: T) => void;
  } = $props();

  function pick(v: T) {
    if (v === value) return;
    value = v;
    onchange?.(v);
  }
</script>

<div class="segmented {className}" role="radiogroup" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      class="segmented-option"
      class:segmented-option-selected={o.value === value}
      role="radio"
      aria-checked={o.value === value}
      onclick={() => pick(o.value)}
    >
      {#if o.icon}<Icon icon={o.icon} size={15} />{/if}{o.label}
    </button>
  {/each}
</div>
