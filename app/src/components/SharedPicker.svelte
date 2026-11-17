<script lang="ts">
  import Modal from '@3pino/ui-kit-web/Modal.svelte';
  import { sharedApi } from '../lib/transport/shared';
  import type { SharedEntry } from '../lib/protocol/SharedEntry';
  import { parentOf } from '../lib/sharedPath';

  // プラグインの ui.pickSharedFiles の画面（共有フォルダの一覧から選ぶ）。選んだら ondone に項目を、取り消しは null を渡す。
  // 一覧は共有フォルダの API（sharedApi.list）をそのまま使う。見た目は既存の部品と design のクラス
  let {
    multiple = false,
    folderOnly = false,
    ondone,
  }: { multiple?: boolean; folderOnly?: boolean; ondone: (picked: SharedEntry[] | null) => void } = $props();

  let path = $state('');
  let entries = $state<SharedEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let picked = $state<SharedEntry[]>([]);
  let seq = 0;

  async function load(p: string): Promise<void> {
    const my = ++seq;
    loading = true;
    error = null;
    try {
      const list = await sharedApi.list(p);
      if (my !== seq) return;
      entries = [...list].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ja') : a.kind === 'dir' ? -1 : 1));
      path = p;
    } catch (e) {
      if (my !== seq) return;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === seq) loading = false;
    }
  }

  // 初めの一覧
  void load('');

  function isPicked(e: SharedEntry): boolean {
    return picked.some((x) => x.path === e.path);
  }

  // 選ぶのを足していく（複数・フォルダだけ）か、1 件で決める（単一のファイル）
  const toggling = $derived(multiple || folderOnly);

  function choose(e: SharedEntry): void {
    if (toggling) {
      picked = isPicked(e) ? picked.filter((x) => x.path !== e.path) : [...picked, e];
    } else {
      ondone([e]);
    }
  }

  function confirmPicked(): void {
    ondone(picked);
  }

  function up(): void {
    if (path !== '') void load(parentOf(path));
  }

  function cancel(): void {
    ondone(null);
  }
</script>

<Modal title="共有フォルダから選ぶ" width={520} onclose={cancel}>
  <div class="shared-picker">
    <div class="shared-picker-bar">
      <button type="button" class="btn" disabled={path === ''} onclick={up}>上へ</button>
      <span class="shared-picker-path muted">{path === '' ? '共有フォルダ' : path}</span>
    </div>

    {#if error}
      <p class="shared-picker-status muted" role="alert">一覧を読めませんでした: {error}</p>
    {:else if loading}
      <p class="shared-picker-status muted">読み込み中…</p>
    {:else if entries.length === 0}
      <p class="shared-picker-status muted">ここにはまだ何もありません</p>
    {:else}
      <ul class="shared-picker-list">
        {#each entries as e (e.path)}
          <li>
            {#if e.kind === 'dir'}
              <button type="button" class="btn ghost shared-picker-row" onclick={() => void load(e.path)}>{e.name}/</button>
              {#if folderOnly}
                <button type="button" class="btn" aria-pressed={isPicked(e)} onclick={() => choose(e)}>{isPicked(e) ? '選択中' : '選ぶ'}</button>
              {/if}
            {:else if !folderOnly}
              <button type="button" class="btn ghost shared-picker-row" aria-pressed={toggling ? isPicked(e) : undefined} onclick={() => choose(e)}>{e.name}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="shared-picker-actions">
      <button type="button" class="btn" onclick={cancel}>取り消す</button>
      {#if toggling}
        <button type="button" class="btn primary" disabled={picked.length === 0} onclick={confirmPicked}>選ぶ（{picked.length}）</button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .shared-picker {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .shared-picker-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .shared-picker-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shared-picker-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
  }
  .shared-picker-list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .shared-picker-row {
    flex: 1;
    justify-content: flex-start;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .shared-picker-status {
    margin: 0;
  }
  .shared-picker-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }
</style>
