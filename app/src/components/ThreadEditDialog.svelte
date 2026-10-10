<script lang="ts">
  import { untrack } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import Plus from '@lucide/svelte/icons/plus';
  import Tag from '@lucide/svelte/icons/tag';
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import TextInput from './ui/TextInput.svelte';
  import Toggle from './ui/Toggle.svelte';
  import TagChip from './TagChip.svelte';
  import type { Message } from '../lib/protocol/Message';
  import type { ThreadTag } from '../lib/protocol/ThreadTag';
  import type { ThreadTagUsage } from '../lib/protocol/ThreadTagUsage';
  import { api } from '../lib/api';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { TAG_ICON_NAMES, tagIcon } from '../lib/tagIcons';
  import { MAX_TAGS, MAX_TAG_LABEL, MAX_TITLE } from '../lib/thread';

  // スレッドのタイトル・タグ・アーカイブを編集する。
  // タイトルとアーカイブは、スレッドを立てた人だけ。タグは誰でも編集できる
  let { root, onclose }: { root: Message; onclose: () => void } = $props();

  const info = $derived(root.thread!);
  const isOwner = $derived(client.me?.id === info.created_by);

  // 編集中の値（開いたときの内容から始める）
  const initial = untrack(() => root.thread);
  let title = $state(initial?.title ?? '');
  let archived = $state(initial?.archived ?? false);
  let tags = $state<ThreadTag[]>((initial?.tags ?? []).map((t) => ({ ...t })));
  /** アイコンを選んでいるタグの位置 */
  let picking = $state<number | null>(null);
  let saving = $state(false);
  let usages = $state<ThreadTagUsage[]>([]);

  $effect(() => {
    api.threadTags().then(
      (list) => (usages = list),
      () => {
        // 候補が出ないだけ
      },
    );
  });

  /** すでに使われているタグのうち、このスレッドにまだ付けていないもの */
  const suggestions = $derived(usages.filter((u) => !tags.some((t) => sameTag(t, u.tag))).slice(0, 20));

  function sameTag(a: ThreadTag, b: ThreadTag): boolean {
    return a.label === b.label && (a.icon ?? null) === (b.icon ?? null);
  }

  function addTag(tag: ThreadTag = { label: '', icon: null }) {
    if (tags.length >= MAX_TAGS) return;
    tags.push({ ...tag });
    if (!tag.label) picking = null;
  }

  function removeTag(i: number) {
    tags.splice(i, 1);
    picking = null;
  }

  function pickIcon(i: number, name: string | null) {
    tags[i].icon = name;
    picking = null;
  }

  async function save() {
    const cleaned = tags.map((t) => ({ label: t.label.trim(), icon: t.icon })).filter((t) => t.label);
    saving = true;
    try {
      if (isOwner && (title.trim() !== (info.title ?? '') || archived !== info.archived)) {
        await api.updateThread(root.id, { title: title.trim(), archived });
      }
      if (JSON.stringify(cleaned) !== JSON.stringify(info.tags)) {
        await api.setThreadTags(root.id, cleaned);
      }
      onclose();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      saving = false;
    }
  }
</script>

<Modal title="スレッドの設定" {onclose} width={460}>
  <div class="thread-edit">
    <label class="thread-edit-field">
      <span class="thread-edit-label">タイトル</span>
      <TextInput bind:value={title} maxlength={MAX_TITLE} placeholder="なし（最初のメッセージの冒頭を表示）" disabled={!isOwner} />
      {#if !isOwner}<span class="thread-edit-note muted">タイトルを変えられるのは、スレッドを立てた人だけです</span>{/if}
    </label>

    <div class="thread-edit-field">
      <span class="thread-edit-label">タグ</span>
      <ul class="thread-edit-tags">
        {#each tags as tag, i (i)}
          {@const Icon = tag.icon ? tagIcon(tag.icon) : Tag}
          <li class="thread-edit-tag">
            <IconButton
              label="アイコンを選ぶ"
              title={tag.icon ?? 'アイコンなし'}
              active={picking === i}
              onclick={() => (picking = picking === i ? null : i)}><Icon size={16} /></IconButton
            >
            <TextInput bind:value={tag.label} maxlength={MAX_TAG_LABEL} placeholder="タグ（絵文字も使えます）" aria-label="タグの名前" />
            <IconButton label="タグを外す" onclick={() => removeTag(i)}><X size={16} /></IconButton>
          </li>
          {#if picking === i}
            <li class="thread-edit-icons" aria-label="アイコン">
              <button type="button" class="thread-edit-icon" class:thread-edit-icon-on={!tag.icon} onclick={() => pickIcon(i, null)}>なし</button>
              {#each TAG_ICON_NAMES as name (name)}
                {@const C = tagIcon(name)}
                <button
                  type="button"
                  class="thread-edit-icon"
                  class:thread-edit-icon-on={tag.icon === name}
                  title={name}
                  aria-label={name}
                  onclick={() => pickIcon(i, name)}><C size={16} /></button
                >
              {/each}
            </li>
          {/if}
        {/each}
      </ul>
      <div>
        <Button icon={Plus} disabled={tags.length >= MAX_TAGS} onclick={() => addTag()}>タグを追加</Button>
      </div>
      {#if suggestions.length > 0}
        <span class="thread-edit-note muted">使われているタグから選ぶ</span>
        <div class="thread-edit-suggest">
          {#each suggestions as u (u.tag.label + '/' + (u.tag.icon ?? ''))}
            <TagChip tag={u.tag} onclick={() => addTag(u.tag)} />
          {/each}
        </div>
      {/if}
    </div>

    {#if isOwner}
      <div class="thread-edit-field thread-edit-row">
        <span>
          <span class="thread-edit-label">アーカイブ</span>
          <span class="thread-edit-note muted">一覧で薄く表示されます。返信はできます</span>
        </span>
        <Toggle bind:checked={archived} label="アーカイブ" />
      </div>
    {/if}

    <div class="modal-actions">
      <Button onclick={onclose}>キャンセル</Button>
      <Button variant="primary" disabled={saving} onclick={save}>保存</Button>
    </div>
  </div>
</Modal>

<style>
  .thread-edit {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .thread-edit-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .thread-edit-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  .thread-edit-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
  }
  .thread-edit-note {
    display: block;
    font-size: 12px;
  }
  .thread-edit-tags {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .thread-edit-tag {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .thread-edit-icons {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .thread-edit-icon {
    display: grid;
    place-items: center;
    min-width: 30px;
    height: 30px;
    padding: 0 4px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font-size: 12px;
  }
  .thread-edit-icon:hover {
    background: var(--hover);
  }
  .thread-edit-icon.thread-edit-icon-on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .thread-edit-suggest {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
