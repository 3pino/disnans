<script lang="ts">
  import { tick } from 'svelte';
  import Modal from './ui/Modal.svelte';
  import TextInput from './ui/TextInput.svelte';
  import SuggestList from './ui/SuggestList.svelte';
  import Icon from './ui/Icon.svelte';
  import { commandList, effectiveHotkeys, filterCommands, type AppCommand } from '../lib/commands.svelte';
  import { commandHost } from '../lib/commandHost.svelte';
  import { formatHotkey } from '../lib/plugins/hotkey';
  import { prefs } from '../lib/stores/prefs.svelte';

  // コマンドパレット（デスクトップ）。打った文字でコマンドを絞り込み、上下で選んで Enter で実行する
  let { onclose }: { onclose: () => void } = $props();

  let query = $state('');
  let index = $state(0);
  let list: SuggestList<AppCommand> | undefined = $state();
  let results: HTMLDivElement | undefined = $state();

  const items = $derived(filterCommands(commandList(), query));

  // 絞り込みを変えたら先頭を選ぶ
  $effect(() => {
    void query;
    index = 0;
  });

  // 選んでいるものが見えるようにスクロールする
  $effect(() => {
    void index;
    void items;
    results?.querySelector('.suggest-list-item-selected')?.scrollIntoView({ block: 'nearest' });
  });

  async function pick(cmd: AppCommand) {
    onclose();
    // 閉じてフォーカスが元に戻ってから実行する（入力欄にフォーカスするコマンドなどのため）
    await tick();
    await commandHost.run(cmd, 'palette');
  }

  function onkeydown(e: KeyboardEvent) {
    // IME 変換中の Enter は確定なので触らない
    if (e.isComposing || e.keyCode === 229) return;
    list?.keydown(e);
  }
</script>

<Modal title="コマンド" {onclose} width={520}>
  <div class="command-palette">
    <TextInput
      class="command-palette-input"
      bind:value={query}
      placeholder="コマンドを検索"
      aria-label="コマンドを検索"
      autocomplete="off"
      spellcheck={false}
      {onkeydown}
    />
    {#if items.length > 0}
      <div class="command-palette-results scroll" bind:this={results}>
        <SuggestList bind:this={list} bind:index class="command-palette-list" label="コマンド" {items} key={(c) => c.id} onpick={(c) => void pick(c)} {onclose}>
          {#snippet item(c)}
            {@const hotkeys = effectiveHotkeys(c, prefs.hotkeys)}
            <span class="command-palette-icon">{#if c.icon}<Icon icon={c.icon} size={18} />{/if}</span>
            <span class="suggest-list-item-title command-palette-name">{c.name}</span>
            {#if c.source}<span class="suggest-list-item-detail command-palette-source">{c.source}</span>{/if}
            {#if hotkeys.length > 0 && commandHost.hotkeysAvailable}
              <span class="command-palette-hotkeys">
                {#each hotkeys as hk (hk)}<kbd class="kbd command-palette-hotkey">{formatHotkey(hk)}</kbd>{/each}
              </span>
            {/if}
          {/snippet}
        </SuggestList>
      </div>
    {:else}
      <p class="muted command-palette-empty">見つかりません</p>
    {/if}
  </div>
</Modal>

<style>
  .command-palette {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .command-palette > :global(.command-palette-input) {
    width: 100%;
  }
  .command-palette-results {
    max-height: min(360px, 55dvh);
  }
  /* 見た目は .suggest-list（app.css）。モーダルの中なので枠と影は付けない */
  .command-palette-results > :global(.command-palette-list) {
    padding: 0;
    border: none;
    box-shadow: none;
  }
  .command-palette-icon {
    display: grid;
    place-items: center;
    width: 22px;
    flex: none;
    color: var(--text-muted);
  }
  .command-palette-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .command-palette-hotkeys {
    display: flex;
    gap: 4px;
    margin-left: auto;
    flex: none;
  }
  .command-palette-empty {
    margin: 0;
    padding: 8px;
    font-size: 14px;
  }
</style>
