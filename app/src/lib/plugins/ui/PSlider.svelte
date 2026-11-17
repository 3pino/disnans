<script lang="ts">
  import { flushSync } from 'svelte';
  import Slider from '@3pino/ui-kit-web/Slider.svelte';

  let {
    label,
    value,
    min,
    max,
    step,
    format,
    disabled,
    class: className,
    oninput,
    onchange,
  }: {
    label: string;
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    format?: (v: number) => string;
    disabled?: boolean;
    class?: string;
    oninput?: (v: number) => void;
    onchange?: (v: number) => void;
  } = $props();
</script>

<Slider
  {label}
  {value}
  {min}
  {max}
  {step}
  {format}
  {disabled}
  class={className}
  oninput={(v) => {
    flushSync();
    oninput?.(v);
  }}
  {onchange}
/>
