<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import SwitchCamera from '@lucide/svelte/icons/switch-camera';
  import IconButton from './ui/IconButton.svelte';
  import type { ScreenShareView } from '../lib/call/screen/view';

  // 通話の画面の中の表示（埋め込み）。共有されている画面（またはカメラ）を小さく出す。押すと全画面（ScreenShareViewer）で開く。
  // 自分が共有しているときは、自分の映像を右下に出す（カメラの切り替えと、共有を止める）
  let { screen, nameOf }: { screen: ScreenShareView; nameOf: (userId: string) => string } = $props();

  const target = $derived(screen.sharers.find((s) => s.peer === screen.selectedPeer) ?? screen.sharers[0] ?? null);
  const targetLabel = $derived(target ? `${nameOf(target.userId)}の${target.source === 'camera' ? 'カメラ' : '画面'}` : '');

  // カメラの映像は、要素に直接入れる（src ではなく srcObject）
  function stream(el: HTMLVideoElement, s: MediaStream) {
    el.srcObject = s;
    void el.play().catch(() => {});
    return {
      update(next: MediaStream) {
        if (el.srcObject !== next) el.srcObject = next;
      },
      destroy() {
        el.srcObject = null;
      },
    };
  }
</script>

{#if target}
  <button type="button" class="screen-embedded" aria-label={`${targetLabel}を大きく見る`} title={`${targetLabel}を大きく見る`} onclick={() => screen.openViewer(target.peer)}>
    {#if target.dataUrl}
      <img src={target.dataUrl} alt={targetLabel} draggable="false" />
    {:else}
      <span class="muted screen-embedded-wait">映像を待っています</span>
    {/if}
    <span class="screen-embedded-name">{targetLabel}</span>
  </button>
{/if}

{#if screen.sharing}
  <div class="screen-self" role="group" aria-label="自分の映像">
    {#if screen.localStream}
      <video class="screen-self-video" use:stream={screen.localStream} muted playsinline aria-label="自分のカメラ"></video>
    {:else if screen.localFrame}
      <img class="screen-self-video" src={`data:${screen.localFrame.mime};base64,${screen.localFrame.data}`} alt="自分の画面" draggable="false" />
    {/if}
    <span class="screen-self-actions">
      {#if screen.source === 'camera' && screen.canSwitchCamera}
        <IconButton label="カメラを切り替え" title="前と後ろのカメラを切り替える" icon={SwitchCamera} iconSize={18} disabled={screen.switching} onclick={() => void screen.switchCamera()} />
      {/if}
      <IconButton label="共有を止める" title="共有を止める" icon={X} iconSize={18} onclick={() => screen.stop()} />
    </span>
  </div>
{/if}

<style>
  .screen-embedded {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-height: 60vh;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-2);
    color: var(--text);
    cursor: zoom-in;
    overflow: hidden;
  }
  .screen-embedded img {
    display: block;
    max-width: 100%;
    max-height: 60vh;
    object-fit: contain;
  }
  .screen-embedded-wait {
    padding: var(--space-7);
  }
  .screen-embedded-name {
    position: absolute;
    left: var(--space-3);
    bottom: var(--space-3);
    max-width: calc(100% - var(--space-6));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface);
    font-size: var(--fs-sm);
  }
  .screen-self {
    position: absolute;
    right: var(--space-4);
    bottom: var(--space-4);
    width: 160px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--surface);
    overflow: hidden;
  }
  .screen-self-video {
    display: block;
    width: 100%;
    height: auto;
  }
  .screen-self-actions {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    display: inline-flex;
    gap: var(--space-2);
  }
</style>
