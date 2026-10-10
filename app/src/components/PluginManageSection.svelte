<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from './ui/Button.svelte';
  import PublishButton from './PublishButton.svelte';
  import Section from './ui/Section.svelte';
  import { pluginHost, type PluginEntry } from '../lib/plugins/host.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import type { PluginVisibility } from '../lib/protocol/PluginVisibility';

  // プラグインの設定画面の下の「配布と削除」。開発中のものは配布（みんな・自分だけ）、配布済みのものは削除できる
  let { entry }: { entry: PluginEntry } = $props();

  /** 配布・削除の最中か */
  let busy = $state(false);

  function nameOf(e: PluginEntry): string {
    return e.manifest?.name ?? e.id;
  }

  function publishedText(name: string, version: string, visibility: PluginVisibility): string {
    return `「${name}」v${version} を${visibility === 'private' ? '自分だけに' : 'みんなに'}配布しました`;
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function publish(e: PluginEntry, visibility: PluginVisibility) {
    if (!e.dev) return;
    busy = true;
    try {
      const info = await pluginHost.publishDev(e.dev, visibility);
      ui.toast(publishedText(info.name, info.version, visibility));
    } catch (err) {
      ui.toast(`配布できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = false;
    }
  }

  async function remove(e: PluginEntry) {
    const priv = e.server?.visibility === 'private';
    const ok = await ui.confirm({
      title: `プラグイン「${nameOf(e)}」を削除しますか？`,
      body: `${priv ? 'あなたのすべての端末' : '全員のクライアント'}から外れます。セッションとカードは残り、同じ ID で配布し直せばまた開けます。`,
      okLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      await pluginHost.remove(e.id);
      ui.toast(`「${nameOf(e)}」を削除しました`);
      // 削除したので、設定画面から一覧に戻る
      ui.closePluginSettings();
    } catch (err) {
      ui.toast(`削除できませんでした: ${message(err)}`, 'error');
    } finally {
      busy = false;
    }
  }
</script>

<Section title="配布と削除" class="plugin-manage">
  <div class="plugin-manage-actions">
    {#if entry.dev}
      <PublishButton disabled={busy || !entry.dev.manifest || !!entry.dev.error} onpublish={(v) => publish(entry, v)} />
    {/if}
    {#if entry.server}
      <Button variant="danger" disabled={busy} onclick={() => remove(entry)}>
        <Trash2 size={15} />削除
      </Button>
    {/if}
  </div>
</Section>

<style>
  .plugin-manage-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
