<script lang="ts">
  import type { Snippet } from 'svelte';

  // ポップアップのメニュー。見た目はグローバルの .menu（app.css）、位置は class で使う側が決める。
  // onclose を渡すと、外側を押したら閉じる透明な幕を出す。
  // 開いたときに画面の下からはみ出すなら、位置の基準（ボタン）の上側に出す（親の既定の位置は top: 100% + 6px を想定）
  let {
    label,
    class: className = '',
    onclose,
    children,
  }: {
    label?: string;
    class?: string;
    onclose?: () => void;
    children?: Snippet;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  /** 上側に出しているか */
  let up = $state(false);

  // 開いたとき（マウントしたとき）に一度だけ測る。既定の位置で画面の下端を超えるなら上に出す
  $effect(() => {
    if (!el) return;
    up = el.getBoundingClientRect().bottom > window.innerHeight;
  });
</script>

{#if onclose}
  <button type="button" class="menu-backdrop" aria-label="閉じる" onclick={onclose}></button>
{/if}
<!-- 上に出すときは、親の top の指定より強く（インラインで）上端を外し、ボタンの上に 6px 空けて置く -->
<div
  bind:this={el}
  class="menu {className}"
  role="menu"
  aria-label={label}
  style:top={up ? 'auto' : null}
  style:bottom={up ? '100%' : null}
  style:margin-bottom={up ? '6px' : null}
>
  {@render children?.()}
</div>
