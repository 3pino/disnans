<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import PublishButton from './PublishButton.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import { pluginHost, type PluginEntry } from '../lib/plugins/host.svelte';
  import { isNewer } from '../lib/semver';
  import { ui } from '../lib/stores/ui.svelte';
  import type { PluginVisibility } from '../lib/protocol/PluginVisibility';

  // プラグインの設定画面の下の「配布と削除」。開発中のものは配布（みんな・自分だけ）、配布済みのものは配布しないか削除できる。
  // 手元のものが配布済みより新しければ、配布済みと同じ範囲へ、ボタン1つでアップデートを配布できる。
  // 版が同じでも中身が違えば（版の上げ忘れ）アップデートとみなす
  let { entry }: { entry: PluginEntry } = $props();

  /** 配布・削除の最中か */
  let busy = $state(false);

  /** 手元のものの中身のハッシュ（配布済みと中身が同じか比べる。計算できなければ null） */
  let localHash = $state<string | null>(null);
  $effect(() => {
    const d = entry.dev;
    localHash = null;
    if (!d) return;
    let stale = false;
    void pluginHost.devHash(d).then((h) => {
      if (!stale) localHash = h;
    });
    return () => {
      stale = true;
    };
  });

  function nameOf(e: PluginEntry): string {
    return e.manifest?.name ?? e.id;
  }

  /** 手元（開発用フォルダ）のバージョン。読めなければ空 */
  function localVersion(e: PluginEntry): string {
    return e.dev?.manifest?.version ?? '';
  }

  /** 手元のパッケージが配布済みより新しいか、版は同じでも中身が違うか（アップデートできるか） */
  function hasUpdate(e: PluginEntry, hash: string | null): boolean {
    const local = localVersion(e);
    if (!e.dev || !e.server || !local) return false;
    if (isNewer(local, e.server.version)) return true;
    return local === e.server.version && hash !== null && hash !== e.server.hash;
  }

  /** アップデートの行の説明（版が同じなら、中身が変わったことを書く） */
  function updateText(e: PluginEntry): string {
    const server = e.server;
    if (!server) return '';
    const same = localVersion(e) === server.version;
    return `v${server.version} → v${localVersion(e)}${same ? '（版は同じで中身が変わりました）' : ''}（${visibilityLabel(server.visibility)}に配布）`;
  }

  function visibilityLabel(visibility: PluginVisibility): string {
    return visibility === 'private' ? '自分だけ' : 'みんな';
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

  /** 配布済みと同じ範囲（自分だけなら自分だけ、みんななら みんな）へアップデートを配布する */
  async function update(e: PluginEntry) {
    if (!e.dev || !e.server) return;
    const visibility = e.server.visibility;
    busy = true;
    try {
      const info = await pluginHost.publishDev(e.dev, visibility);
      ui.toast(`「${info.name}」を v${info.version} にアップデートしました（${visibilityLabel(visibility)}に配布）`);
    } catch (err) {
      ui.toast(`アップデートできませんでした: ${message(err)}`, 'error');
    } finally {
      busy = false;
    }
  }

  /** 配布を取り消す（サーバーから外す。手元のフォルダはそのまま） */
  async function unpublish(e: PluginEntry) {
    const priv = e.server?.visibility === 'private';
    const ok = await ui.confirm({
      title: `「${nameOf(e)}」の配布を取り消しますか？`,
      body: `${priv ? 'あなたのすべての端末' : '全員のクライアント'}から外れます。手元の開発用フォルダは残るので、あとで配布し直せます。`,
      okLabel: '配布しない',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      await pluginHost.remove(e.id);
      ui.toast(`「${nameOf(e)}」の配布を取り消しました`);
    } catch (err) {
      ui.toast(`配布を取り消せませんでした: ${message(err)}`, 'error');
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
  {#if hasUpdate(entry, localHash) && entry.server}
    <SettingRow name="アップデートがあります" description={updateText(entry)} class="plugin-manage-update">
      {#snippet control()}
        <IconButton label="アップデートを配布" disabled={busy || !!entry.dev?.error} onclick={() => update(entry)}>
          <Upload size={16} />
        </IconButton>
      {/snippet}
    </SettingRow>
  {/if}
  <div class="plugin-manage-actions">
    {#if entry.dev}
      <PublishButton
        disabled={busy || !entry.dev.manifest || !!entry.dev.error}
        onpublish={(v) => publish(entry, v)}
        onunpublish={entry.server ? () => unpublish(entry) : undefined}
      />
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
