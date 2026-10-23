<script lang="ts">
  // SortableList.test.ts 用の入れ物（テストのためだけ）。並びを外から変えられるように、状態をここに持つ
  import SortableList from './SortableList.svelte';

  type Item = { id: string; name: string };

  let {
    onmove,
    onremove,
    removable,
  }: {
    onmove: (id: string, toIndex: number) => void;
    onremove?: (id: string) => void;
    removable?: (item: Item) => boolean;
  } = $props();

  let items = $state<Item[]>([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);

  /** テストから並びを外から変える */
  export function setItems(next: Item[]) {
    items = next;
  }
</script>

<SortableList {items} getId={(x) => x.id} getLabel={(x) => x.name} {onmove} {onremove} {removable}>
  {#snippet row(x)}
    <span class="row-text">{x.name}</span><input class="row-input" />
  {/snippet}
</SortableList>
