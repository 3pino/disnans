<script lang="ts">
  import { flushSync } from 'svelte';
  import SegmentedButton from '@3pino/ui-kit-web/SegmentedButton.svelte';

  let {
    options,
    value,
    label,
    onchange,
  }: {
    options: { value: string; label: string; icon?: string }[];
    value: string;
    label?: string;
    onchange?: (value: string) => void;
  } = $props();
</script>

<SegmentedButton
  {options}
  {value}
  {label}
  onchange={(v) => {
    flushSync();
    onchange?.(v);
  }}
/>
