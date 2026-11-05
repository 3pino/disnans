<script lang="ts">
  import { orderViews, viewLabel, type ScreenViewEntry } from '../lib/call/screen/order';
  import type { ScreenShareView } from '../lib/call/screen/view';

  // 通話の画面の下半分に並べる、共有されている映像（カメラも画面も）。Zoom のように、上は参加者、下は映像。
  // 並べる順は「自分の今のデバイス > 自分の別のデバイス > ほかの人」。横に並べ、はみ出した分は横にスクロールする。
  // 1 つは正方形（.screen-stage）に収める。ここでは拡大・移動はしない（上下のスクロールを奪わない）。押すと、その映像を全画面で開く
  let { screen, nameOf, myUserId = null }: { screen: ScreenShareView; nameOf: (userId: string) => string; myUserId?: string | null } = $props();

  const views = $derived(orderViews(screen, myUserId));

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

  const labelOf = (v: ScreenViewEntry) => viewLabel(v, nameOf);
</script>

<ul class="call-streams-strip" aria-label="共有されている映像">
  {#each views as v (v.peer)}
    <li class="call-streams-item">
      <button type="button" class="screen-stage" data-peer={v.peer} aria-label="{labelOf(v)}を全画面で見る" onclick={() => screen.openViewer(v.peer)}>
        {#if v.local && screen.localStream}
          <video class="screen-stage-media" use:stream={screen.localStream} muted playsinline aria-hidden="true"></video>
        {:else if v.dataUrl}
          <img class="screen-stage-media" src={v.dataUrl} alt="" draggable="false" />
        {:else}
          <span class="muted screen-stage-wait">映像を待っています</span>
        {/if}
        <span class="screen-stage-name">{labelOf(v)}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .call-streams-strip {
    display: flex;
    align-items: stretch;
    gap: var(--space-4);
    height: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
  }
  .call-streams-item {
    flex: none;
    height: 100%;
    aspect-ratio: 1 / 1;
    max-width: 100%;
  }
  .screen-stage {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-2);
    color: var(--text);
    overflow: hidden;
    cursor: pointer;
  }
  .screen-stage-media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
  }
  .screen-stage-wait {
    padding: var(--space-4);
    text-align: center;
  }
  .screen-stage-name {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: var(--space-2) var(--space-3);
    overflow: hidden;
    background: var(--scrim-strong);
    color: var(--on-scrim);
    font-size: var(--fs-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    -webkit-user-select: none;
    user-select: none;
  }
</style>
