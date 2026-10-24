<script lang="ts">
  import { viewTexts } from '../lib/viewTexts';
  import { onMount } from 'svelte';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Tablet from '@lucide/svelte/icons/tablet';
  import Laptop from '@lucide/svelte/icons/laptop';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import HeadphonesIcon from '@lucide/svelte/icons/headphones';
  import HeadphoneOff from '@lucide/svelte/icons/headphone-off';
  import Speaker from '@lucide/svelte/icons/speaker';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import Settings from '@lucide/svelte/icons/settings';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import Avatar from './Avatar.svelte';
  import PanelBar from './ui/PanelBar.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { longPress } from '../lib/call/longPress';
  import { normalizeDevice, statusBadges, type StatusBadge } from '../lib/call/pure';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 通話の画面（全画面版）。チャットや設定と並ぶタブ。参加者を大きなアバターのグリッドで出し、操作のボタンを下に置く。
  // 参加者を押すとミュート（自分）/ 自分の側だけ消音（相手）、長押し（PC は右クリック）で通話から外す。CallBar と同じ操作

  const deviceIcons = { smartphone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor };
  const badgeIcons: Record<StatusBadge, typeof Mic> = { muted: MicOff, deafened: HeadphoneOff, 'local-muted': VolumeX };
  const badgeLabels: Record<StatusBadge, string> = { muted: 'ミュート中', deafened: 'スピーカーミュート中', 'local-muted': 'このデバイスでは消音中' };

  const people = $derived(call.participants);

  function nameOf(userId: string): string {
    return client.user(userId)?.display_name || viewTexts.unknownUser;
  }

  function title(p: (typeof people)[number]): string {
    const states = statusBadges(p, p.localMuted).map((b) => badgeLabels[b]);
    const state = states.length ? ` ・${states.join('・')}` : '';
    if (p.self) return `${nameOf(p.userId)}（自分）${state} ・押すとミュート`;
    return `${nameOf(p.userId)}${state} ・押すと自分の側だけ${p.localMuted ? '音を戻す' : '消音する'} ・長押しで通話から外す`;
  }

  function press(p: (typeof people)[number]) {
    if (p.self) call.toggleMute();
    else call.toggleLocalMute(p.peer);
  }

  const selectedOutput = $derived(call.outputs.find((o) => o.selected)?.id ?? '');

  // 出力先の一覧は、開いたときに取り直す（参加中は store が定期的にも取り直す）
  onMount(() => void call.refreshOutputs());

  // プラグインの領域（call.addPanel。API v10）。要素はプラグインが持ち、この画面が開いている間だけここに入れる
  const panels = $derived(call.joined ? call.panels.filter((p) => p.visible) : []);

  function mountPanel(node: HTMLElement, p: { id: number; el: HTMLElement }) {
    let cur = p;
    node.append(cur.el);
    call.panelMounted(cur.id, true);
    return {
      update(next: { id: number; el: HTMLElement }) {
        if (next.id === cur.id && next.el === cur.el) return;
        call.panelMounted(cur.id, false);
        cur.el.remove();
        cur = next;
        node.append(cur.el);
        call.panelMounted(cur.id, true);
      },
      destroy() {
        cur.el.remove();
        call.panelMounted(cur.id, false);
      },
    };
  }

  // プラグインのボタンは、押したらフォーカスを外す（許可のダイアログから戻ったあとも明るいままにならないように）
  function pressPluginButton(e: MouseEvent, run: () => void) {
    (e.currentTarget as HTMLElement | null)?.blur();
    run();
  }
</script>

<section class="call-view" aria-label="通話">
  <PanelBar>
    <h1 class="call-view-title" class:call-view-title-live={call.joined}>
      <AudioLines size={18} />{call.pending ? '参加中…' : call.joined ? '通話中' : '通話'}
    </h1>
  </PanelBar>

  <div class="call-view-body">
    {#each panels as p (p.id)}
      <section class="call-view-panel" aria-label={p.label || undefined} use:mountPanel={{ id: p.id, el: p.el }}></section>
    {/each}
    {#if people.length === 0}
      <p class="muted call-view-empty">いま通話にいる人はいません</p>
    {:else}
      <ul class="call-grid">
        {#each people as p (p.peer)}
          {@const badges = statusBadges(p, p.localMuted)}
          {@const device = normalizeDevice(p.device)}
          {@const DeviceIcon = device ? deviceIcons[device] : null}
          <li class="call-tile">
            <button
              type="button"
              class="call-person"
              class:call-person-speaking={p.speaking}
              class:call-person-muted={p.muted}
              class:call-person-connecting={!p.connected}
              data-peer={p.peer}
              title={title(p)}
              aria-label={title(p)}
              onclick={() => press(p)}
              use:longPress={{ onLongPress: () => (!p.self && call.joined ? void call.kick(p.peer) : undefined) }}
            >
              <Avatar user={client.user(p.userId)} id={p.userId} size={96} />
              {#if badges.length > 0}
                <span class="call-badges" aria-hidden="true">
                  {#each badges as b (b)}
                    {@const BadgeIcon = badgeIcons[b]}
                    <span class="call-badge call-badge-status" class:call-badge-local={b === 'local-muted'}><BadgeIcon size={14} /></span>
                  {/each}
                </span>
              {/if}
              {#if DeviceIcon}
                <span class="call-badge call-badge-device" aria-hidden="true"><DeviceIcon size={14} /></span>
              {/if}
            </button>
            <span class="call-name">{nameOf(p.userId)}{p.self ? '（自分）' : ''}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="call-view-controls" role="group" aria-label="通話の操作">
    {#if call.joined}
      {#each call.barButtons as b (b.id)}
        <IconButton class={b.active ? 'call-active' : ''} label={b.label} title={b.label} icon={b.icon} disabled={b.disabled} onclick={(e) => pressPluginButton(e, b.onClick)} />
      {/each}
      <IconButton
        class={call.deafened ? 'call-active' : ''}
        label={call.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート'}
        title={call.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート（相手の声を全部消す）'}
        icon={call.deafened ? HeadphoneOff : HeadphonesIcon}
        iconSize={22}
        onclick={() => call.toggleDeafen()}
      />
      {#if call.outputs.length > 0}
        <!-- 音の出力先（設定の「通話」と同じ選択欄） -->
        <label class="call-view-output" title="音の出力先">
          <Speaker size={18} aria-hidden="true" />
          <select class="input call-view-output-select" aria-label="音の出力先" value={selectedOutput} onchange={(e) => void call.chooseOutput(e.currentTarget.value)}>
            {#if !selectedOutput}<option value="" disabled></option>{/if}
            {#each call.outputs as o (o.id)}
              <option value={o.id}>{o.label}</option>
            {/each}
          </select>
        </label>
      {/if}
      <IconButton label="通話の設定" title="通話の設定" icon={Settings} iconSize={22} onclick={() => ui.openSettingsSub('call')} />
      <IconButton class="call-leave" label="通話から抜ける" title="通話から抜ける" icon={PhoneOff} iconSize={22} onclick={() => call.leave()} />
    {:else}
      <IconButton label="通話の設定" title="通話の設定" icon={Settings} iconSize={22} onclick={() => ui.openSettingsSub('call')} />
      <Button variant="primary" icon={Phone} disabled={call.joining} onclick={() => void call.join()}>{call.joining ? '接続中…' : '参加'}</Button>
    {/if}
  </div>
</section>

<style>
  .call-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .call-view-title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    margin: 0;
    font-size: var(--fs-body);
    font-weight: var(--fw-bold);
    color: var(--text-muted);
  }
  .call-view-title-live {
    color: var(--success);
  }
  .call-view-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-7);
  }
  .call-view-panel {
    margin: 0 0 var(--space-7);
  }
  .call-view-empty {
    margin: 40px 0;
    text-align: center;
    /* 案内の文で、内容ではないので選べないようにする */
    -webkit-user-select: none;
    user-select: none;
  }
  .call-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 20px var(--space-6);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .call-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
  }
  .call-name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }
  .call-person {
    position: relative;
    display: block;
    width: 96px;
    height: 96px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    -webkit-touch-callout: none;
    user-select: none;
    transition: box-shadow 0.1s;
  }
  /* 話している人は緑の輪で強調する */
  .call-person-speaking {
    box-shadow: 0 0 0 4px var(--success);
  }
  .call-person-muted :global(.avatar) {
    opacity: 0.55;
  }
  .call-person-connecting {
    opacity: 0.6;
  }
  .call-badge {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid var(--bg);
    background: var(--surface-2);
    color: var(--text);
  }
  .call-badge-device {
    position: absolute;
    right: -2px;
    bottom: -2px;
  }
  .call-badges {
    position: absolute;
    left: -2px;
    bottom: -2px;
    display: flex;
  }
  .call-badges .call-badge + .call-badge {
    margin-left: -8px;
  }
  .call-badge-status {
    background: var(--danger);
    color: var(--on-accent);
  }
  .call-badge-local {
    background: var(--surface-2);
    color: var(--danger);
  }
  .call-view-controls {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .call-view-output {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    color: var(--text-muted);
  }
  /* 長い機器名は「…」で省略する（設定の「通話」の選択欄と同じ） */
  .call-view-output-select {
    max-width: 180px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .call-view-controls :global(.call-active) {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .call-view-controls :global(.call-leave) {
    color: var(--danger);
  }
  .call-view-controls :global(.call-leave:hover) {
    background: var(--danger-soft);
  }
  @media (prefers-reduced-motion: reduce) {
    .call-person {
      transition: none;
    }
  }
</style>
