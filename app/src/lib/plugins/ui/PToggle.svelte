<script lang="ts">
  import { flushSync } from 'svelte';
  import Toggle from '@3pino/ui-kit-web/Toggle.svelte';

  // 押すと見た目も切り替わる（Toggle の checked は、親が bind しなければ部品の中で持つ）
  let { value, label, onchange }: { value: boolean; label?: string; onchange?: (value: boolean) => void } = $props();
</script>

<Toggle
  checked={value}
  {label}
  onchange={(v) => {
    // 見た目を、いまの状態にそろえてから、プラグインへ知らせる（押した直後に DOM を見ても、切り替わっている）
    flushSync();
    onchange?.(v);
  }}
/>
