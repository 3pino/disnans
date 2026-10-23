<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import X from '@lucide/svelte/icons/x';
  import type { IconRef } from '../../lib/icons.svelte';

  // 設定の1行。左にアイコン（任意）・名前と説明、右に操作（control）を置く。
  // 見た目はグローバルの .setting-row（@3pino/design-system の components.css）。プラグイン向けの ui.setting も同じ DOM を作る
  // 配置は app.css の .setting-row（名前と操作は同じ段、説明は狭いときだけ下段）。ui.setting と同じ DOM のまま
  // onclick を渡すと、行全体が1つの ghost ボタンになる（名前が読み上げの名前。control は飾りだけにする。中にボタンは置けない）
  // deleting のとき（削除モード）は、操作部品（control）の代わりに × を出す。ondelete が無い行（削除できない項目）は、何も出さない
  let {
    name,
    description,
    icon,
    class: className = '',
    control,
    onclick,
    deleting = false,
    ondelete,
    deleteLabel,
  }: {
    name: string;
    description?: string;
    /** 名前の左に出すアイコン（名前か Svelte の部品） */
    icon?: IconRef;
    class?: string;
    control?: Snippet;
    /** 行全体を押せるボタンにする。押したときに呼ばれる */
    onclick?: () => void;
    /** 削除モード（リストで長押しすると入る） */
    deleting?: boolean;
    /** 削除モードの × を押したとき。省くと × は出ない（削除できない項目） */
    ondelete?: () => void;
    /** × の読み上げの名前 */
    deleteLabel?: string;
  } = $props();
</script>

{#snippet content()}
  {#if icon}<Icon {icon} size={20} class="setting-row-icon" />{/if}
  <div class="setting-row-info">
    <div class="setting-row-name">{name}</div>
    {#if description}<div class="setting-row-description">{description}</div>{/if}
  </div>
  {#if deleting}
    {#if ondelete}
      <div class="setting-row-control">
        <IconButton label={deleteLabel ?? '削除'} class="setting-row-delete" onclick={ondelete}>
          <X size={16} />
        </IconButton>
      </div>
    {/if}
  {:else if control}
    <div class="setting-row-control">{@render control()}</div>
  {/if}
{/snippet}

{#if onclick}
  <button type="button" class="setting-row setting-row-button {className}" aria-label={name} {onclick}>
    {@render content()}
  </button>
{:else}
  <div class="setting-row {className}">
    {@render content()}
  </div>
{/if}
