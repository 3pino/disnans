<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Camera from '@lucide/svelte/icons/camera';
  import SwitchCamera from '@lucide/svelte/icons/switch-camera';
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import { captureJpeg, cameraErrorText, photoFileName } from '../lib/camera';

  // 写真を撮るモーダル。映像を見ながらシャッターを押すと、JPEG のファイルを onphoto に渡す（添付の流れに乗る）。
  // 閉じる・撮ったあとはカメラを止める。前後のカメラは、2 つ以上あるときだけ切り替えを出す
  let { onphoto, onclose }: { onphoto: (file: File) => void; onclose: () => void } = $props();

  let video: HTMLVideoElement | undefined = $state();
  let facing = $state<'environment' | 'user'>('environment');
  let cameras = $state(0);
  let ready = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** 起動の番号。古い起動の結果は捨てる（切り替えを連打しても、最後の1回だけ生かす） */
  let generation = 0;
  let stream: MediaStream | null = null;

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    ready = false;
  }

  async function start() {
    const my = ++generation;
    stopStream();
    error = null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
      if (my !== generation) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      if (video) {
        video.srcObject = s;
        await video.play().catch(() => {});
      }
      ready = true;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (my === generation) cameras = devices.filter((d) => d.kind === 'videoinput').length;
    } catch (e) {
      if (my !== generation) return;
      console.error('[camera] カメラを起動できませんでした', e);
      error = cameraErrorText(e);
    }
  }

  function switchCamera() {
    facing = facing === 'environment' ? 'user' : 'environment';
    void start();
  }

  async function shoot() {
    if (!video || !ready || busy) return;
    busy = true;
    try {
      const blob = await captureJpeg(video);
      onphoto(new File([blob], photoFileName(new Date()), { type: 'image/jpeg' }));
    } catch (e) {
      console.error('[camera] 写真を作れませんでした', e);
      error = e instanceof Error ? e.message : '写真を作れませんでした';
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    untrack(() => void start());
    return () => {
      generation++;
      stopStream();
    };
  });
</script>

<Modal title="写真を撮る" {onclose} width={480}>
  <div class="camera-capture">
    <video bind:this={video} class="camera-capture-preview" playsinline muted autoplay aria-label="カメラの映像"></video>
    {#if error}<p class="camera-capture-error" role="alert">{error}</p>{/if}
    <div class="modal-actions camera-capture-actions">
      {#if cameras > 1}
        <Button class="camera-capture-switch" icon={SwitchCamera} onclick={switchCamera}>カメラを切り替え</Button>
      {/if}
      <Button class="camera-capture-cancel" onclick={onclose}>閉じる</Button>
      <Button class="camera-capture-shoot" variant="primary" icon={Camera} disabled={!ready || busy} onclick={shoot}>撮る</Button>
    </div>
  </div>
</Modal>

<style>
  .camera-capture {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .camera-capture-preview {
    width: 100%;
    max-height: 60vh;
    border-radius: var(--radius);
    background: var(--surface-2);
    object-fit: contain;
  }
  .camera-capture-error {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-md);
  }
  .camera-capture-actions {
    flex-wrap: wrap;
  }
</style>
