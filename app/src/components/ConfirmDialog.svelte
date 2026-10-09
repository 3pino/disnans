<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import { ui } from '../lib/stores/ui.svelte';
</script>

{#if ui.confirmReq}
  {@const req = ui.confirmReq}
  <Modal title={req.title} onclose={() => req.resolve(false)} width={380}>
    {#if req.body}<p class="confirm-dialog-message">{req.body}</p>{/if}
    <div class="modal-actions confirm-dialog-actions">
      <Button class="confirm-dialog-cancel" onclick={() => req.resolve(false)}>キャンセル</Button>
      <Button class="confirm-dialog-ok" variant={req.danger ? 'danger' : 'primary'} onclick={() => req.resolve(true)}>{req.okLabel}</Button>
    </div>
  </Modal>
{/if}

<style>
  .confirm-dialog-message {
    margin: 0 0 18px;
    white-space: pre-line;
    color: var(--text-muted);
    font-size: 14px;
  }
</style>
