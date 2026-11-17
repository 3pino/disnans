<script lang="ts">
  import IconButton from '@3pino/ui-kit-web/IconButton.svelte';
  import Slot from './Slot.svelte';

  let {
    label,
    icon,
    iconSize,
    active,
    disabled,
    class: className,
    parts,
    onclick,
  }: {
    label: string;
    icon?: string;
    iconSize?: number;
    active?: boolean;
    disabled?: boolean;
    class?: string;
    parts: readonly (string | Node)[];
    onclick?: () => void;
  } = $props();
</script>

<IconButton {label} {icon} {iconSize} {active} {disabled} class={className} {onclick}>
  <Slot {parts} />
</IconButton>
