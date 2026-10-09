<script lang="ts">
  // プラグインの設定タブ（addSettingTab）を描く。表示のたびに空の containerEl で display を呼び、閉じたら hide を呼ぶ
  let { tab, name }: { tab: Disnans.SettingTab; name: string } = $props();

  let el: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);

  $effect(() => {
    const t = tab;
    const c = el;
    if (!c) return;
    c.replaceChildren();
    error = null;
    try {
      t.display(c);
    } catch (e) {
      console.error(`[plugin] ${name} の設定の表示で例外`, e);
      error = `設定を表示できませんでした: ${e instanceof Error ? e.message : String(e)}`;
    }
    return () => {
      try {
        t.hide?.();
      } catch (e) {
        console.error(`[plugin] ${name} の設定の hide で例外`, e);
      }
      c.replaceChildren();
    };
  });
</script>

<!-- 中身はプラグインが描く。入力欄の文字は選択できるようにする -->
<div class="plugin-setting-tab" bind:this={el}></div>
{#if error}<p class="plugin-setting-tab-error">{error}</p>{/if}

<style>
  .plugin-setting-tab {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .plugin-setting-tab-error {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }
</style>
