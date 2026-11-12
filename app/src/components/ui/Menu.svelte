<script lang="ts">
  import type { Snippet } from 'svelte';

  // ポップアップのメニュー。見た目はグローバルの .menu（@3pino/design-system の components.css）、位置は class で使う側が決める。
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
  /** 左右にはみ出す分だけ横にずらす量（px。画面の端から 8px 空ける） */
  let shift = $state(0);
  const EDGE = 8;

  // 開いたとき（マウントしたとき）に一度だけ測る。既定の位置で画面の下端を超えるなら上に出す。
  // 左右の端を超えるなら（左端のボタンから右揃えで開いたときなど）、使える範囲に収まるよう横にずらす。
  // 使える範囲は画面ではなくシェルの中身（広い画面で左に縦に並ぶナビバーは含めない。ナビバーの上に出ない）。
  // シェルの外（モバイルのナビバーは下で、横の範囲を取らない）では、従来どおり画面の幅
  function usableX(): { left: number; right: number } {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const shell = el?.closest('.shell');
    const nav = shell?.querySelector(':scope > .nav-bar-side');
    return { left: nav ? Math.max(0, nav.getBoundingClientRect().right) : 0, right: vw };
  }
  $effect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    up = r.bottom > window.innerHeight;
    const { left, right } = usableX();
    if (r.left < left + EDGE) shift = left + EDGE - r.left;
    else if (r.right > right - EDGE) shift = Math.max(left + EDGE - r.left, right - EDGE - r.right);
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
  style:translate={shift ? `${shift}px 0` : null}
>
  {@render children?.()}
</div>
