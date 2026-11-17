<script lang="ts">
  import Menu from '@3pino/ui-kit-web/Menu.svelte';
  import MenuItem from '@3pino/ui-kit-web/MenuItem.svelte';

  // disnans.ui.menu の中身。項目を選ぶと、先に閉じてから onClick を呼ぶのは ui.ts（onpick）が行う
  let {
    label,
    items,
    onclose,
  }: {
    label?: string;
    items: { text: string; icon?: string; danger?: boolean; disabled?: boolean; reason?: string; onpick: () => void }[];
    onclose: () => void;
  } = $props();
</script>

<Menu {label} {onclose}>
  {#each items as it}
    <MenuItem icon={it.icon} danger={it.danger} disabled={it.disabled} reason={it.reason} onclick={() => it.onpick()}>{it.text}</MenuItem>
  {/each}
</Menu>
