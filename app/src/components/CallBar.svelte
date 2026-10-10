<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Tablet from '@lucide/svelte/icons/tablet';
  import Laptop from '@lucide/svelte/icons/laptop';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import VolumeX from '@lucide/svelte/icons/volume-x';
  import Settings from '@lucide/svelte/icons/settings';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import Avatar from './Avatar.svelte';
  import Button from './ui/Button.svelte';
  import IconButton from './ui/IconButton.svelte';
  import { call } from '../lib/call/instance.svelte';
  import { longPress } from '../lib/call/longPress';
  import { normalizeDevice, statusBadges, type StatusBadge } from '../lib/call/pure';
  import { client } from '../lib/stores/client.svelte';
  import { ui } from '../lib/stores/ui.svelte';

  // 通話のバー（画面上部の枠 TopBarSlot に出る）。いま通話にいる人と、通話の操作。
  // 退出ボタンはバーの右端。参加者の長押し（PC は右クリック）で、その人を通話から外せる

  const deviceIcons = { smartphone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor };
  const badgeIcons: Record<StatusBadge, typeof Mic> = { muted: MicOff, deafened: VolumeX, 'local-muted': VolumeX };
  const badgeLabels: Record<StatusBadge, string> = { muted: 'ミュート中', deafened: 'スピーカーミュート中', 'local-muted': 'この端末では消音中' };

  const people = $derived(call.participants);

  function nameOf(userId: string): string {
    return client.user(userId)?.display_name || '不明なユーザー';
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
</script>

<div class="call-bar" class:call-bar-live={call.joined} role="group" aria-label="通話">
  <span class="call-label" class:call-label-live={call.joined}>
    <AudioLines size={16} />{call.joined ? '通話中' : '通話'}
  </span>

  <div class="call-people">
    {#each people as p (p.peer)}
      {@const badges = statusBadges(p, p.localMuted)}
      {@const device = normalizeDevice(p.device)}
      {@const DeviceIcon = device ? deviceIcons[device] : null}
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
        <Avatar user={client.user(p.userId)} id={p.userId} size={30} />
        {#if badges.length > 0}
          <span class="call-badges" aria-hidden="true">
            {#each badges as b (b)}
              {@const BadgeIcon = badgeIcons[b]}
              <span class="call-badge call-badge-status" class:call-badge-local={b === 'local-muted'}><BadgeIcon size={9} /></span>
            {/each}
          </span>
        {/if}
        {#if DeviceIcon}
          <span class="call-badge call-badge-device" aria-hidden="true"><DeviceIcon size={9} /></span>
        {/if}
      </button>
    {/each}
  </div>

  {#if call.joined}
    <div class="call-controls">
      {#each call.barButtons as b (b.id)}
        <IconButton
          class={b.active ? 'call-active' : ''}
          label={b.label}
          title={b.label}
          icon={b.icon}
          disabled={b.disabled}
          onclick={() => b.onClick()}
        />
      {/each}
      <IconButton
        class={call.muted ? 'call-active' : ''}
        label={call.muted ? 'ミュートを解除' : 'ミュート'}
        title={call.muted ? 'ミュートを解除' : 'ミュート'}
        icon={call.muted ? MicOff : Mic}
        onclick={() => call.toggleMute()}
      />
      <IconButton
        class={call.deafened ? 'call-active' : ''}
        label={call.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート'}
        title={call.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート（相手の声を全部消す）'}
        icon={call.deafened ? VolumeX : Volume2}
        onclick={() => call.toggleDeafen()}
      />
      <IconButton label="通話の設定" title="通話の設定" icon={Settings} onclick={() => ui.openSettingsSub('call')} />
      <!-- 退出は右端に、危険色で置く -->
      <IconButton class="call-leave" label="通話から抜ける" title="通話から抜ける" icon={PhoneOff} onclick={() => call.leave()} />
    </div>
  {:else if !call.joining}
    <div class="call-controls">
      <Button variant="primary" icon={Phone} onclick={() => void call.join()}>参加</Button>
    </div>
  {/if}
</div>

<style>
  .call-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    /* 右の余白は小さく（退出ボタンが画面の右端に寄る） */
    padding: 4px 4px 4px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex: none;
  }
  .call-label {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 6px;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }
  .call-label-live {
    color: var(--success);
  }
  /* 人が多いときは横にスクロールする（ボタンは動かさない） */
  .call-people {
    display: flex;
    align-items: center;
    flex: 1 1 0;
    gap: 10px;
    min-width: 0;
    padding: 4px 6px 6px 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .call-person {
    position: relative;
    display: block;
    flex: none;
    width: 30px;
    height: 30px;
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
  .call-person-speaking {
    box-shadow: 0 0 0 2px var(--success);
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
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--surface);
    background: var(--surface-2);
    color: var(--text);
  }
  /* 右下: 端末の種類 */
  .call-badge-device {
    position: absolute;
    right: -4px;
    bottom: -4px;
  }
  /* 左下: ミュートなどの状態（複数なら右へ少し重ねて並べる） */
  .call-badges {
    position: absolute;
    left: -4px;
    bottom: -4px;
    display: flex;
  }
  .call-badges .call-badge + .call-badge {
    margin-left: -5px;
  }
  .call-badge-status {
    background: var(--danger);
    color: var(--on-accent);
  }
  .call-badge-local {
    background: var(--surface-2);
    color: var(--danger);
  }
  .call-controls {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }
  .call-controls :global(.call-active) {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .call-controls :global(.call-leave) {
    color: var(--danger);
  }
  .call-controls :global(.call-leave:hover) {
    background: var(--danger-soft);
  }
  @media (prefers-reduced-motion: reduce) {
    .call-person {
      transition: none;
    }
  }
</style>
