<script lang="ts">
  import { tick } from 'svelte';
  import Avatar from './Avatar.svelte';
  import { client } from '../lib/stores/client.svelte';
  import { bodyToDraft, draftToBody, filterUsers, mentionQuery } from '../lib/mentions';
  import type { User } from '../lib/protocol/User';

  let {
    initial = '',
    placeholder = '',
    enterSends = true,
    maxHeight = 240,
    onsubmit,
    oncancel,
    onfiles,
    onarrowupempty,
    oninput,
  }: {
    initial?: string;
    placeholder?: string;
    enterSends?: boolean;
    maxHeight?: number;
    onsubmit?: () => void;
    oncancel?: () => void;
    onfiles?: (files: File[]) => void;
    onarrowupempty?: () => void;
    oninput?: (text: string) => void;
  } = $props();

  const mentionMap = new Map<string, string>();
  // svelte-ignore state_referenced_locally
  let text = $state(bodyToDraft(initial, client.users, mentionMap));
  let ta: HTMLTextAreaElement | undefined = $state();
  let suggest = $state<{ start: number; query: string; items: User[]; index: number } | null>(null);

  export function getBody(): string {
    return draftToBody(text, mentionMap).trim();
  }
  export function getText(): string {
    return text;
  }
  export function clear(): void {
    text = '';
    mentionMap.clear();
    suggest = null;
    void tick().then(resize);
  }
  export function focus(): void {
    ta?.focus();
  }

  function resize() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px';
  }

  $effect(() => {
    void text;
    resize();
  });

  function updateSuggest() {
    if (!ta) return;
    const q = mentionQuery(text, ta.selectionStart);
    if (!q) {
      suggest = null;
      return;
    }
    const items = filterUsers(client.userList, q.query);
    suggest = items.length ? { ...q, items, index: 0 } : null;
  }

  async function pick(u: User) {
    if (!suggest || !ta) return;
    const insert = '@' + u.display_name + ' ';
    const end = ta.selectionStart;
    text = text.slice(0, suggest.start) + insert + text.slice(end);
    mentionMap.set(u.display_name, u.id);
    const caret = suggest.start + insert.length;
    suggest = null;
    await tick();
    ta.focus();
    ta.setSelectionRange(caret, caret);
  }

  function onkeydown(e: KeyboardEvent) {
    // IME 変換中の Enter は確定なので触らない
    if (e.isComposing || e.keyCode === 229) return;
    if (suggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = suggest.items.length;
        suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        void pick(suggest.items[suggest.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        suggest = null;
        return;
      }
    }
    if (e.key === 'Enter' && enterSends && !e.shiftKey) {
      e.preventDefault();
      onsubmit?.();
      return;
    }
    if (e.key === 'Escape' && oncancel) {
      e.preventDefault();
      oncancel();
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && onarrowupempty) {
      e.preventDefault();
      onarrowupempty();
    }
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length && onfiles) {
      e.preventDefault();
      onfiles(files);
    }
  }
</script>

<div class="wrap">
  {#if suggest}
    <ul class="suggest" role="listbox" aria-label="メンション">
      {#each suggest.items as u, i (u.id)}
        <li role="option" aria-selected={i === suggest.index}>
          <button
            type="button"
            class:sel={i === suggest.index}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => pick(u)}
          >
            <Avatar user={u} id={u.id} size={22} />
            <span class="name">{u.display_name}</span>
            <span class="login">{u.login_name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <textarea
    bind:this={ta}
    bind:value={text}
    rows="1"
    {placeholder}
    {onkeydown}
    {onpaste}
    oninput={() => {
      updateSuggest();
      oninput?.(text);
    }}
    onclick={updateSuggest}
    onblur={() => setTimeout(() => (suggest = null), 150)}
    enterkeyhint={enterSends ? 'send' : 'enter'}
  ></textarea>
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    border: none;
    outline: none;
    background: transparent;
    padding: 8px 4px;
    line-height: 1.5;
    max-height: 40vh;
    scrollbar-width: thin;
  }
  textarea::placeholder {
    color: var(--text-muted);
    opacity: 0.8;
  }
  .suggest {
    position: absolute;
    left: -8px;
    right: -8px;
    bottom: calc(100% + 10px);
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    z-index: 20;
  }
  .suggest button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
  }
  .suggest button.sel {
    background: var(--accent-soft);
  }
  .name {
    font-weight: 600;
  }
  .login {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
