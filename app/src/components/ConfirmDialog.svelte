<script lang="ts">
  import Modal from './Modal.svelte';
  import { ui } from '../lib/stores/ui.svelte';
</script>

{#if ui.confirmReq}
  {@const req = ui.confirmReq}
  <Modal title={req.title} onclose={() => req.resolve(false)} width={380}>
    {#if req.body}<p class="body">{req.body}</p>{/if}
    <div class="actions">
      <button type="button" class="btn" onclick={() => req.resolve(false)}>キャンセル</button>
      <button type="button" class="btn primary" class:danger={req.danger} onclick={() => req.resolve(true)}>{req.okLabel}</button>
    </div>
  </Modal>
{/if}

<style>
  .body {
    margin: 0 0 18px;
    white-space: pre-line;
    color: var(--text-muted);
    font-size: 14px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
