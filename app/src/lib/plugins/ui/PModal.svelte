<script lang="ts">
  import Modal from '@3pino/ui-kit-web/Modal.svelte';
  import PButton from './PButton.svelte';
  import Slot from './Slot.svelte';

  let {
    title,
    width,
    parts,
    actions,
    onclose,
  }: {
    title: string;
    width?: number;
    parts: readonly (string | Node)[];
    actions: { text?: string; icon?: string; variant?: 'default' | 'primary' | 'danger' | 'ghost'; label?: string; disabled?: boolean; onclick?: () => void }[];
    onclose: () => void;
  } = $props();
</script>

<Modal {title} {width} {onclose}>
  <Slot {parts} />
  {#if actions.length > 0}
    <div class="modal-actions">
      {#each actions as a}<PButton {...a} />{/each}
    </div>
  {/if}
</Modal>
