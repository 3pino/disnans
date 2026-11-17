<script lang="ts">
  import Section from '@3pino/ui-kit-web/Section.svelte';
  import Slot from './Slot.svelte';

  let { title, class: className, parts }: { title: string; class?: string; parts: readonly (string | Node)[] } = $props();
</script>

<Section {title} class={className}>
  <Slot {parts} />
</Section>
