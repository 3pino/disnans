<script lang="ts">
  import { flushSync } from 'svelte';
  import NavBar, { type NavBarItem } from '@3pino/ui-kit-web/NavBar.svelte';

  // 選ぶと見た目も切り替わる（NavBar の selected は親が持つので、ここで持つ）
  let {
    items,
    selected: initialSelected,
    label,
    onselect,
  }: { items: NavBarItem[]; selected?: string; label?: string; onselect?: (id: string) => void } = $props();
  // svelte-ignore state_referenced_locally -- 最初の値だけを使う（その後は、選ぶたびにここで持つ）
  let selected = $state(initialSelected);
</script>

<NavBar
  {items}
  {selected}
  {label}
  onselect={(id) => {
    selected = id;
    flushSync();
    onselect?.(id);
  }}
/>
