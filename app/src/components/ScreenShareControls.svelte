<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor-up';
  import MonitorOff from '@lucide/svelte/icons/monitor-off';
  import Video from '@lucide/svelte/icons/video';
  import VideoOff from '@lucide/svelte/icons/video-off';
  import SwitchCamera from '@lucide/svelte/icons/switch-camera';
  import IconButton from './ui/IconButton.svelte';
  import type { ScreenShareView } from '../lib/call/screen/view';

  // 画面共有・カメラ共有の押すボタン（通話のバーと通話の画面に置く）。
  // 押したら共有を始める・止める（エンジンの toggleScreen / toggleCamera）。カメラの共有中は、前後のカメラを切り替えられるとき（2 つ以上）に切り替えを出す
  let { screen }: { screen: ScreenShareView } = $props();

  const sharingScreen = $derived(screen.sharing && screen.source === 'screen');
  const sharingCamera = $derived(screen.sharing && screen.source === 'camera');
  const busy = $derived(screen.starting || screen.switching);
</script>

<div class="screen-share-controls" role="group" aria-label="画面の共有">
  {#if screen.canScreen}
    <IconButton
      class={sharingScreen ? 'call-active' : ''}
      label={sharingScreen ? '画面の共有を止める' : '画面を共有'}
      title={sharingScreen ? '画面の共有を止める' : '画面を共有'}
      icon={sharingScreen ? MonitorOff : Monitor}
      iconSize={22}
      disabled={busy}
      aria-busy={screen.starting}
      onclick={() => void screen.toggleScreen()}
    />
  {/if}
  {#if screen.canCamera}
    <IconButton
      class={sharingCamera ? 'call-active' : ''}
      label={sharingCamera ? 'カメラの共有を止める' : 'カメラを共有'}
      title={sharingCamera ? 'カメラの共有を止める' : 'カメラを共有'}
      icon={sharingCamera ? VideoOff : Video}
      iconSize={22}
      disabled={busy}
      onclick={() => void screen.toggleCamera()}
    />
  {/if}
  {#if sharingCamera && screen.canSwitchCamera}
    <IconButton label="カメラを切り替え" title="前と後ろのカメラを切り替える" icon={SwitchCamera} iconSize={22} disabled={busy} onclick={() => void screen.switchCamera()} />
  {/if}
</div>

<style>
  .screen-share-controls {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .screen-share-controls :global(.call-active) {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
