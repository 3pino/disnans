<script lang="ts">
  import SettingRow from '@3pino/ui-kit-web/SettingRow.svelte';
  import Slot from './Slot.svelte';

  let {
    name,
    description,
    icon,
    node,
  }: { name: string; description?: string; icon?: string; node?: string | Node } = $props();
</script>

{#if node}
  <SettingRow {name} {description} {icon}>
    {#snippet control()}<Slot parts={[node]} />{/snippet}
  </SettingRow>
{:else}
  <SettingRow {name} {description} {icon} />
{/if}
