<script lang="ts">
  import { onMount } from 'svelte';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import IconButton from './ui/IconButton.svelte';
  import Section from './ui/Section.svelte';
  import SettingRow from './ui/SettingRow.svelte';
  import StatusLine from './ui/StatusLine.svelte';
  import TextInput from './ui/TextInput.svelte';
  import { deviceList } from '../lib/stores/deviceList.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import type { DeviceInfo } from '../lib/transport/device';

  // 設定の「デバイス」: 同じアカウントのデバイスの一覧。名前の変更と、古いデバイスの削除。
  // このデバイス自身は削除できない（削除すると、このデバイスの設定が保存できなくなるため）。
  // 削除したデバイスの設定も消える。確認のあと1件ずつ消す。読み込みは設定を書かない。

  const fmt = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

  onMount(() => {
    void deviceList.load();
  });

  function when(ms: number): string {
    return fmt.format(new Date(ms));
  }

  /** 補足: このデバイスか、最後に使った日時（登録日時は出さない） */
  function meta(d: DeviceInfo): string {
    const parts: string[] = [];
    if (deviceList.isSelf(d.device_id)) parts.push('このデバイス');
    parts.push(`最終ログイン ${when(d.last_seen_at)}`);
    if (!d.has_prefs) parts.push('設定はまだありません');
    return parts.join(' · ');
  }

  async function rename(d: DeviceInfo, value: string) {
    if (value.trim() === d.name) return;
    await deviceList.rename(d.device_id, value);
  }

  async function remove(d: DeviceInfo) {
    const ok = await ui.confirm({
      title: `「${d.name}」を削除しますか？`,
      body: 'そのデバイスの設定も消えます。元に戻せません。削除されたデバイスは、アプリを起動し直すともう一度登録されます（消えた設定は戻りません）。',
      okLabel: '削除する',
      danger: true,
    });
    if (!ok) return;
    const done = await deviceList.remove(d.device_id);
    if (done) ui.toast(`「${d.name}」を削除しました`);
  }

  const busy = $derived(deviceList.loading || deviceList.busy !== null);
</script>

<Section title="デバイス" class="device-list-settings">
  {#if deviceList.error}
    <StatusLine kind="error" class="device-list-settings-error">{deviceList.error}</StatusLine>
  {/if}

  <div class="device-list-settings-actions">
    <IconButton class="device-list-settings-refresh" label="一覧を読み直す" disabled={busy} onclick={() => void deviceList.load()}>
      <RefreshCw size={18} />
    </IconButton>
    {#if busy}
      <StatusLine busy>読み込み中…</StatusLine>
    {/if}
  </div>

  {#if !deviceList.loading && deviceList.items.length === 0 && !deviceList.error}
    <p class="muted device-list-settings-empty">デバイスはまだありません</p>
  {/if}

  {#each deviceList.items as d (d.device_id)}
    {@const self = deviceList.isSelf(d.device_id)}
    <SettingRow name={d.name} description={meta(d)} class="device-list-settings-row">
      {#snippet control()}
        <div class="device-list-settings-controls">
          <TextInput
            class="device-list-settings-name"
            aria-label="デバイスの名前"
            value={d.name}
            disabled={busy}
            spellcheck={false}
            autocomplete="off"
            onchange={(e) => void rename(d, e.currentTarget.value)}
          />
          {#if !self}
            <IconButton class="device-list-settings-delete" label="このデバイスを削除" disabled={busy} onclick={() => void remove(d)}>
              <Trash2 size={16} />
            </IconButton>
          {:else}
            <!-- 削除ボタンの幅を空けて、入力欄の位置をそろえる -->
            <span class="device-list-settings-delete-space" aria-hidden="true"></span>
          {/if}
        </div>
      {/snippet}
    </SettingRow>
  {/each}
</Section>

<style>
  /* 名前の入力と削除ボタンを 1 段に並べる */
  .device-list-settings-controls {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
  }
  .device-list-settings-controls :global(.device-list-settings-name) {
    flex: 1;
    min-width: 160px;
  }
  .device-list-settings-controls :global(.device-list-settings-delete) {
    flex: none;
    color: var(--danger);
  }
  /* IconButton（34px）と同じ幅 */
  .device-list-settings-delete-space {
    flex: none;
    width: 34px;
  }
  /* 幅が狭いときは、操作を行の最下段に出して、入力欄の幅を確保する */
  @container setting-row (max-width: 30em) {
    :global(.device-list-settings-row .setting-row-control) {
      grid-column: 1 / -1;
      grid-row: 3;
      margin: var(--space-3) 0 0;
    }
  }
</style>
