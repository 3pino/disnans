<script lang="ts">
  import Button from '@3pino/ui-kit-web/Button.svelte';

  // disnans.ui.button / modal の actions の 1 つ分。文字があれば文字つき、なければアイコンだけ（.btn-icon-only）
  let {
    text,
    icon,
    variant,
    label,
    disabled,
    onclick,
  }: {
    text?: string;
    icon?: string;
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    label?: string;
    disabled?: boolean;
    onclick?: () => void;
  } = $props();
</script>

{#if text}
  <Button {icon} {variant} {label} {disabled} {onclick}>{text}</Button>
{:else}
  <Button {icon} {variant} {label} {disabled} {onclick} />
{/if}
