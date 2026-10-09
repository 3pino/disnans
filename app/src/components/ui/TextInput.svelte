<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  // 見た目はグローバルの .input（app.css）。1行の入力欄
  let {
    value = $bindable(''),
    class: className = '',
    ...rest
  }: Omit<HTMLInputAttributes, 'value'> & { value?: string } = $props();
</script>

<input class="input {className}" bind:value {...rest} />
