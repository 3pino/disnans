<script lang="ts">
  import StatusLine from '@3pino/ui-kit-web/StatusLine.svelte';
  import Slot from './Slot.svelte';

  let {
    kind,
    icon,
    busy,
    class: className,
    parts,
  }: {
    kind?: 'default' | 'muted' | 'ok' | 'accent' | 'warn' | 'error';
    icon?: string;
    busy?: boolean;
    class?: string;
    parts: readonly (string | Node)[];
  } = $props();
</script>

<StatusLine {kind} {icon} {busy} class={className}>
  <Slot {parts} />
</StatusLine>
