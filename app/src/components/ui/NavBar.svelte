<script lang="ts" module>
  import type { IconRef } from '../../lib/icons.svelte';

  export type NavBarItem = {
    id: string;
    label: string;
    icon: IconRef;
    /** 右上に出す数字など（0・空文字列・null なら出さない） */
    badge?: number | string | null;
    /** 新しいものがあることを示す点（右上に出す）。値は読み上げ用の文言（null・空文字列なら出さない） */
    alert?: string | null;
  };
</script>

<script lang="ts">
  import Icon from './Icon.svelte';

  // タブのバー（アイコン + ラベル、選択中は強調、右上にバッジ）。本体の下のナビゲーションに使う。
  // 見た目はグローバルの .nav-bar（@3pino/design-system の components.css）。プラグイン向けの ui.navbar も同じ DOM を作る

  let {
    items,
    selected,
    label,
    id,
    class: className = '',
    onselect,
  }: {
    items: NavBarItem[];
    selected?: string;
    /** 読み上げ用の名前 */
    label?: string;
    id?: string;
    class?: string;
    onselect?: (id: string) => void;
  } = $props();
</script>

<nav {id} class="nav-bar {className}" aria-label={label}>
  {#each items as it (it.id)}
    <button
      type="button"
      class="nav-bar-item"
      class:nav-bar-item-selected={it.id === selected}
      aria-current={it.id === selected ? 'page' : undefined}
      onclick={() => onselect?.(it.id)}
    >
      <span class="nav-bar-item-icon">
        <Icon icon={it.icon} size={22} />
        {#if it.badge !== undefined && it.badge !== null && it.badge !== 0 && it.badge !== ''}
          <span class="badge nav-bar-item-badge">{it.badge}</span>
        {/if}
        {#if it.alert}
          <span class="nav-bar-item-alert" role="img" aria-label={it.alert}></span>
        {/if}
      </span>
      <span class="nav-bar-item-label">{it.label}</span>
    </button>
  {/each}
</nav>

<style>
  /* タッチの画面では、押したあとも :hover が残って文字の色が変わったままになる（選んでいない項目が白く残る）。
     ホバーの色は、ホバーできる画面だけにする。選んでいる項目の色は、ホバーのあとも変えない（どの項目も同じ規則） */
  @media (hover: none) {
    .nav-bar .nav-bar-item:hover {
      color: var(--text-muted);
    }
  }
  .nav-bar .nav-bar-item.nav-bar-item-selected {
    color: var(--accent);
  }
</style>
