<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import FileIcon from '@lucide/svelte/icons/file';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import MessageInput from './MessageInput.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { uploadFile } from '../lib/api';
  import type { Attachment } from '../lib/protocol/Attachment';
  import type { ComposerAction } from '../lib/composerActions';
  import { formatSize } from '../lib/format';
  import { MAX_BODY } from '../lib/errors';

  let { threadId, placeholder }: { threadId: string | null; placeholder: string } = $props();

  type Upload = {
    key: number;
    file: File;
    preview: string | null;
    progress: number;
    attachment: Attachment | null;
    error: string | null;
    abort: () => void;
  };

  let input: MessageInput | undefined = $state();
  let fileEl: HTMLInputElement | undefined = $state();
  let uploads = $state<Upload[]>([]);
  let menuOpen = $state(false);
  let hasText = $state(false);
  let seq = 0;

  const uploading = $derived(uploads.some((u) => !u.attachment && !u.error));
  const ready = $derived(uploads.filter((u) => u.attachment));
  const canSend = $derived(!uploading && (hasText || ready.length > 0) && client.ready);

  const actions: ComposerAction[] = [
    { id: 'file', label: 'ファイルを添付', icon: Paperclip, run: (c) => c.pickFiles() },
  ];
  const ctx = $derived({
    threadId,
    pickFiles: () => fileEl?.click(),
  });

  export function addFiles(files: File[]) {
    for (const file of files) {
      const key = ++seq;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const h = uploadFile(file, (r) => {
        const u = uploads.find((x) => x.key === key);
        if (u) u.progress = r;
      });
      uploads.push({ key, file, preview, progress: 0, attachment: null, error: null, abort: h.abort });
      h.promise.then(
        (a) => {
          const u = uploads.find((x) => x.key === key);
          if (u) {
            u.attachment = a;
            u.progress = 1;
          }
        },
        (e: Error) => {
          const u = uploads.find((x) => x.key === key);
          if (u) u.error = e.message;
        },
      );
    }
    input?.focus();
  }

  export function focus() {
    input?.focus();
  }

  function removeUpload(u: Upload) {
    if (!u.attachment && !u.error) u.abort();
    if (u.preview) URL.revokeObjectURL(u.preview);
    uploads = uploads.filter((x) => x.key !== u.key);
  }

  function submit() {
    if (!input || !canSend) return;
    const body = input.getBody();
    const attachments = ready.map((u) => u.attachment!);
    if (!body && attachments.length === 0) return;
    if (body.length > MAX_BODY) {
      ui.toast(`メッセージが長すぎます（${body.length} / ${MAX_BODY}文字）`, 'error');
      return;
    }
    client.sendMessage({ threadId, body, attachments });
    input.clear();
    hasText = false;
    // プレビュー用の blob URL は、仮表示が終わるまで残しておく必要がないので破棄する
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
    uploads = uploads.filter((u) => !u.attachment);
  }

  function editLast() {
    const me = client.me?.id;
    if (!me) return;
    const msgs = client.timeline(threadId).messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].author_id === me) {
        ui.editing = msgs[i].id;
        return;
      }
    }
  }
</script>

<div class="composer" class:composer-in-thread={threadId !== null}>
  {#if uploads.length > 0}
    <div class="composer-upload-tray">
      {#each uploads as u (u.key)}
        <div class="composer-upload" class:composer-upload-error={!!u.error} title={u.error ?? u.file.name}>
          {#if u.preview}
            <img class="composer-upload-preview" src={u.preview} alt="" />
          {:else}
            <div class="composer-upload-file-icon"><FileIcon size={20} /><span>{formatSize(u.file.size)}</span></div>
          {/if}
          <span class="composer-upload-name">{u.file.name}</span>
          {#if u.error}
            <span class="composer-upload-error-icon"><CircleAlert size={16} /></span>
          {:else if !u.attachment}
            <div class="composer-upload-progress"><div class="composer-upload-progress-fill" style:width="{Math.round(u.progress * 100)}%"></div></div>
          {/if}
          <button type="button" class="composer-upload-remove" aria-label="取り消す" onclick={() => removeUpload(u)}><X size={12} /></button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="composer-row">
    <div class="composer-plus">
      <button
        type="button"
        class="icon-btn composer-plus-button"
        class:active={menuOpen}
        aria-label="その他の操作"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Plus size={20} />
      </button>
      {#if menuOpen}
        <button type="button" class="composer-menu-backdrop" aria-label="閉じる" onclick={() => (menuOpen = false)}></button>
        <div class="composer-menu" role="menu">
          {#each actions.filter((a) => !a.when || a.when(ctx)) as a (a.id)}
            <button
              type="button"
              class="composer-menu-item"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                a.run(ctx);
              }}
            >
              <a.icon size={18} />
              {a.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <MessageInput
      bind:this={input}
      {placeholder}
      enterSends={!ui.isMobile}
      onsubmit={submit}
      onfiles={addFiles}
      onarrowupempty={editLast}
      oninput={(t) => (hasText = t.trim().length > 0)}
    />

    <button type="button" class="composer-send" disabled={!canSend} aria-label="送信" onclick={submit}>
      <Send size={18} />
    </button>
  </div>

  <input
    bind:this={fileEl}
    type="file"
    class="composer-file-input"
    multiple
    hidden
    onchange={(e) => {
      const files = [...(e.currentTarget.files ?? [])];
      e.currentTarget.value = '';
      if (files.length) addFiles(files);
    }}
  />
</div>

<style>
  .composer {
    padding: 0 16px 14px;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 4px 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    transition: border-color 0.12s;
  }
  .composer-row:focus-within {
    border-color: var(--accent);
  }
  .composer-row > :global(.icon-btn),
  .composer-plus {
    margin-bottom: 3px;
  }
  .composer-plus {
    position: relative;
  }
  .composer-menu-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 29;
    cursor: default;
  }
  .composer-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: -4px;
    z-index: 30;
    min-width: 200px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .composer-menu .composer-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .composer-menu .composer-menu-item:hover {
    background: var(--surface-2);
  }
  .composer-send {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-bottom: 2px;
    border: none;
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    flex: none;
    transition: opacity 0.12s;
  }
  .composer-send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .composer-upload-tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 4px 2px 8px;
  }
  .composer-upload {
    position: relative;
    flex: none;
    width: 88px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    overflow: hidden;
  }
  .composer-upload.composer-upload-error {
    border-color: var(--danger);
  }
  .composer-upload .composer-upload-preview,
  .composer-upload-file-icon {
    display: block;
    width: 100%;
    height: 64px;
    object-fit: cover;
  }
  .composer-upload-file-icon {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 2px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .composer-upload-name {
    display: block;
    padding: 2px 6px 4px;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-upload-progress {
    position: absolute;
    left: 0;
    right: 0;
    top: 60px;
    height: 4px;
    background: var(--surface-2);
  }
  .composer-upload-progress .composer-upload-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .composer-upload-error-icon {
    position: absolute;
    top: 22px;
    left: 34px;
    color: var(--danger);
  }
  .composer-upload-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: color-mix(in oklch, var(--bg) 80%, transparent);
    color: var(--text);
  }
  @media (max-width: 767px) {
    .composer {
      padding: 0 8px 8px;
    }
    /* スレッドは全画面でボトムナビがないので、ナビゲーションバーの分を空ける */
    .composer.composer-in-thread {
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
  }
</style>
