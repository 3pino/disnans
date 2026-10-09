<script lang="ts">
  import { fillIcon, iconRevision, type IconRef } from '../../lib/icons.svelte';

  // アイコン。icon は名前（本体の独自のもの・プラグインが登録したもの・Lucide）か、Svelte のアイコン部品。
  // 名前のときは lib/icons.svelte.ts で引いて描く。見た目はグローバルの .icon（app.css）。
  // プラグイン向けの ui.icon も同じ DOM を作る
  let {
    icon,
    size = 24,
    class: className = '',
    label,
  }: {
    icon: IconRef;
    size?: number;
    class?: string;
    /** 読み上げ用の名前。省略すると飾り（aria-hidden） */
    label?: string;
  } = $props();

  let el: SVGSVGElement | undefined = $state();

  $effect(() => {
    // 登録や Lucide の読み込みで変わったら描き直す
    void iconRevision();
    if (el && typeof icon === 'string') fillIcon(el, icon);
  });
</script>

{#if typeof icon === 'string'}
  <svg
    bind:this={el}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    class="icon {className}"
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : 'true'}
  ></svg>
{:else}
  {@const C = icon}
  <C {size} class="icon {className}" />
{/if}
