<script lang="ts">
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Tablet from '@lucide/svelte/icons/tablet';
  import Laptop from '@lucide/svelte/icons/laptop';
  import Monitor from '@lucide/svelte/icons/monitor';
  import IconButton from './ui/IconButton.svelte';
  import Menu from './ui/Menu.svelte';
  import { DEVICE_KIND_LABELS, DEVICE_KINDS, deviceKind, type DeviceKind } from '../lib/deviceKind.svelte';

  // プロフィールのカードの右に置く「この端末の種類」。この端末だけの設定（サーバーには送らない）。
  // 今の種類のアイコンを押すと、種類のアイコンが並んだポップアップが開き、選ぶと閉じる（リアクションの絵文字と同じ形式）
  const icons: Record<DeviceKind, typeof Smartphone> = { smartphone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor };

  let open = $state(false);
  const CurrentIcon = $derived(icons[deviceKind.value]);

  function pick(kind: DeviceKind) {
    deviceKind.set(kind);
    open = false;
  }

  /** 開いているときの Esc は、閉じるだけにする */
  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="device-kind">
  <IconButton
    class="device-kind-button"
    label="この端末の種類: {DEVICE_KIND_LABELS[deviceKind.value]}"
    title="この端末の種類: {DEVICE_KIND_LABELS[deviceKind.value]}"
    active={open}
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <CurrentIcon size={20} />
  </IconButton>
  {#if open}
    <Menu class="device-kind-menu" label="この端末の種類" onclose={() => (open = false)}>
      {#each DEVICE_KINDS as k (k)}
        {@const Icon = icons[k]}
        <button
          type="button"
          role="menuitemradio"
          class="device-kind-option"
          class:device-kind-option-selected={k === deviceKind.value}
          aria-checked={k === deviceKind.value}
          aria-label={DEVICE_KIND_LABELS[k]}
          title={DEVICE_KIND_LABELS[k]}
          onclick={() => pick(k)}
        >
          <Icon size={20} />
        </button>
      {/each}
    </Menu>
  {/if}
</div>

<style>
  .device-kind {
    position: relative;
    flex: none;
    margin-left: auto;
  }
  /* 位置はここで決める。幅は中身（4つのアイコン）に合わせる */
  .device-kind > :global(.device-kind-menu) {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(4, 40px);
    gap: 2px;
    padding: 8px;
  }
  .device-kind-option {
    display: grid;
    place-items: center;
    width: 40px;
    height: 38px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .device-kind-option:hover,
  .device-kind-option:focus-visible {
    background: var(--surface-2);
    color: var(--text);
    outline: none;
  }
  .device-kind-option.device-kind-option-selected {
    background: var(--accent-soft);
    color: var(--accent);
  }
</style>
