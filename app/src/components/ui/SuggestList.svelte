<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  // 入力欄の補完候補の一覧（メンションなど）。見た目はグローバルの .suggest-list（app.css）、位置は class で使う側が決める。
  // キー操作は、入力欄の keydown から keydown() を呼んでもらって処理する
  let {
    items,
    index = $bindable(0),
    label,
    key,
    class: className = '',
    onpick,
    onclose,
    item,
  }: {
    items: T[];
    /** 選択中の候補の位置 */
    index?: number;
    label: string;
    key: (it: T) => string;
    class?: string;
    onpick: (it: T) => void;
    onclose?: () => void;
    /** 候補1つ分の中身 */
    item: Snippet<[T]>;
  } = $props();

  /** 候補の操作に使ったキーなら処理して true を返す */
  export function keydown(e: KeyboardEvent): boolean {
    const n = items.length;
    if (n === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      onpick(items[index]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose?.();
      return true;
    }
    return false;
  }
</script>

<ul class="suggest-list {className}" role="listbox" aria-label={label}>
  {#each items as it, i (key(it))}
    <li class="suggest-list-option" role="option" aria-selected={i === index}>
      <button
        type="button"
        class="suggest-list-item"
        class:suggest-list-item-selected={i === index}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => onpick(it)}
      >
        {@render item(it)}
      </button>
    </li>
  {/each}
</ul>
