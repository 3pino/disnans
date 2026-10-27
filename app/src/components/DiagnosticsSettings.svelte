<script lang="ts">
  import Share2 from '@lucide/svelte/icons/share-2';
  import Download from '@lucide/svelte/icons/download';
  import Copy from '@lucide/svelte/icons/copy';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Button from './ui/Button.svelte';
  import { buildDiagReport, clearDiagLog, exportDiagReport } from '../lib/diagLog';
  import { copyText } from '../lib/clipboard';
  import { getServerUrl } from '../lib/config';
  import { capabilities, isAndroid, isTauri } from '../lib/platform';
  import { client } from '../lib/stores/client.svelte';
  import { notifications } from '../lib/stores/notifications.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { updater } from '../lib/stores/updater.svelte';

  // 設定の「アプリ」の診断ログ（設定の木の Slot `diagnostics`）。
  // 記録は lib/diagLog.ts（Android はネイティブのファイル）。ここでは書き出して送る・コピー・消去だけをする

  const android = isTauri() && isAndroid();
  let busy = $state(false);

  /** 先頭に載せる、このアプリの状態。メッセージの本文は入れない */
  function context(): [string, string][] {
    return [
      ['版', updater.version ? `v${updater.version}` : updater.supported ? '?' : '開発版'],
      ['ユーザー', client.me?.login_name ?? '（未ログイン）'],
      ['サーバー', getServerUrl() || '（同じオリジン）'],
      ['チャットの接続', `${client.status}${client.linkReason ? ` (${client.linkReason})` : ''}`],
      ['通知', `${notifications.backend} 許可=${notifications.permission}${notifications.android ? ` 常駐=${JSON.stringify(notifications.android)}` : ''}`],
      ['方針', JSON.stringify(capabilities())],
    ];
  }

  async function run(action: (text: string) => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await updater.loadVersion();
      await action(await buildDiagReport(context()));
    } catch (e) {
      ui.toast(`ログを書き出せませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      busy = false;
    }
  }

  function send() {
    void run(async (text) => {
      const shared = await exportDiagReport(text);
      if (!shared) ui.toast('ログを保存しました');
    });
  }

  function copy() {
    void run(async (text) => {
      ui.toast((await copyText(text)) ? 'ログをコピーしました' : 'コピーできませんでした', 'info');
    });
  }

  async function clear() {
    const ok = await ui.confirm({
      title: '診断ログを消しますか？',
      body: 'これまでの記録を消します。不具合が起きる前に消しておくと、送るログが短くなります。',
      okLabel: '消す',
    });
    if (!ok) return;
    try {
      await clearDiagLog();
      ui.toast('診断ログを消しました');
    } catch (e) {
      ui.toast(`消せませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
</script>

<div class="diagnostics-settings">
  <p class="muted diagnostics-text">
    「通知が来ない」「通話が切れる」などが起きたら、そのあとでログを書き出して開発者に送ってください。接続や通知・通話の状態を記録しています（メッセージの本文は含みません。サーバーのアドレスとユーザー名は含みます）。
  </p>
  <div class="diagnostics-actions">
    <Button class="diagnostics-send" variant="primary" disabled={busy} onclick={send}>
      {#if android}<Share2 size={15} />ログを送る{:else}<Download size={15} />ログを保存{/if}
    </Button>
    <Button class="diagnostics-copy" disabled={busy} onclick={copy}>
      <Copy size={15} />コピー
    </Button>
    <Button class="diagnostics-clear" variant="ghost" disabled={busy} onclick={() => void clear()}>
      <Trash2 size={15} />消去
    </Button>
  </div>
</div>

<style>
  .diagnostics-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .diagnostics-text {
    margin: 0;
    font-size: var(--fs-sm);
  }
  .diagnostics-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }
</style>
