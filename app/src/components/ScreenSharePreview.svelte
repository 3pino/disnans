<script lang="ts">
  import type { Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import SwitchCamera from '@lucide/svelte/icons/switch-camera';
  import IconButton from './ui/IconButton.svelte';
  import Button from './ui/Button.svelte';
  import ScreenImageStage from './ScreenImageStage.svelte';
  import Maximize from '@lucide/svelte/icons/maximize-2';
  import type { ScreenShareView } from '../lib/call/screen/view';

  // 通話の画面の中の表示（埋め込み）。共有されている画面を、その場で拡大・移動できる（ScreenImageStage: Ctrl+ホイール・ピンチ・ダブルタップ・ドラッグ）。
  // 「大きく見る」ボタンで全画面（ScreenShareViewer）を開く。カード全体は押しても開かない（拡大の操作を奪わないため）。
  // 自分が共有しているときは、自分の映像を同じ全幅のカードで流れの中に出す（カメラの切り替えと、共有を止める は見出しの行）
  let { screen, nameOf }: { screen: ScreenShareView; nameOf: (userId: string) => string } = $props();

  const target = $derived(screen.sharers.find((s) => s.peer === screen.selectedPeer) ?? screen.sharers[0] ?? null);
  const selfLabel = $derived(screen.source === 'camera' ? '自分のカメラ' : '自分の画面');
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

{#snippet card(label: string, aria: string, actions: Snippet | undefined, body: Snippet)}
  <div class="screen-embedded" role="group" aria-label={aria}>
    <div class="screen-embedded-bar">
      <span class="screen-embedded-name">{label}</span>
      {@render actions?.()}
    </div>
    {@render body()}
  </div>
{/snippet}

{#if target}
  {@render card(
    targetLabel,
    targetLabel,
    remoteActions,
    remoteBody,
  )}
{/if}

{#if screen.sharing}
  {@render card(
    selfLabel,
    '自分の映像',
    selfActions,
    selfBody,
  )}
{/if}

{#snippet remoteActions()}
  <Button variant="ghost" icon={Maximize} label={`${targetLabel}を大きく見る`} onclick={() => screen.openViewer(target!.peer)} />
{/snippet}

{#snippet remoteBody()}
  {#if target?.dataUrl}
    {#key target.peer}
      <ScreenImageStage src={target.dataUrl} alt={targetLabel} embedded />
    {/key}
  {:else}
    <span class="muted screen-embedded-wait">映像を待っています</span>
  {/if}
{/snippet}

{#snippet selfActions()}
  {#if screen.source === 'camera' && screen.canSwitchCamera}
    <IconButton label="カメラを切り替え" title="前と後ろのカメラを切り替える" icon={SwitchCamera} iconSize={18} disabled={screen.switching} onclick={() => void screen.switchCamera()} />
  {/if}
  <IconButton label="共有を止める" title="共有を止める" icon={X} iconSize={18} onclick={() => screen.stop()} />
{/snippet}

{#snippet selfBody()}
  {#if screen.localStream}
    <video class="screen-self-video" use:stream={screen.localStream} muted playsinline aria-label="自分のカメラ"></video>
  {:else if screen.localFrame}
    <ScreenImageStage src={`data:${screen.localFrame.mime};base64,${screen.localFrame.data}`} alt="自分の画面" embedded />
  {:else}
    <span class="muted screen-embedded-wait">映像を待っています</span>
  {/if}
{/snippet}

<style>
  .screen-embedded {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-2);
    color: var(--text);
    overflow: hidden;
  }
  .screen-embedded-wait {
    padding: var(--space-7);
  }
  .screen-embedded-bar {
    position: relative;
    z-index: 1;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .screen-embedded-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm, 4px);
    background: var(--surface);
    font-size: var(--fs-sm);
  }
  /* 自分の映像は、受け取った画面と同じ全幅のカードの中（通常の流れ・重ならない） */
  .screen-self-video {
    display: block;
    width: 100%;
    height: auto;
    max-height: 60vh;
    object-fit: contain;
  }
</style>
