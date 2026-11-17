<script lang="ts">
  import TextInput from '@3pino/ui-kit-web/TextInput.svelte';

  let {
    value,
    placeholder,
    onchange,
  }: { value?: string; placeholder?: string; onchange?: (value: string) => void } = $props();
</script>

<TextInput {value} {placeholder} oninput={(e) => onchange?.(e.currentTarget.value)} />
