<script lang="ts">
  import Modal from './Modal.svelte';
  import { ui } from '../lib/stores/ui.svelte';
</script>

{#if ui.confirmReq}
  {@const req = ui.confirmReq}
  <Modal title={req.title} onclose={() => req.resolve(false)} width={380}>
    {#if req.body}<p class="confirm-dialog-message">{req.body}</p>{/if}
    <div class="confirm-dialog-actions">
      <button type="button" class="btn confirm-dialog-cancel" onclick={() => req.resolve(false)}>キャンセル</button>
      <button type="button" class="btn primary confirm-dialog-ok" class:danger={req.danger} onclick={() => req.resolve(true)}>{req.okLabel}</button>
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
  .confirm-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
