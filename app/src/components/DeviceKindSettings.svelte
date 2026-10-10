<script lang="ts">
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Tablet from '@lucide/svelte/icons/tablet';
  import Laptop from '@lucide/svelte/icons/laptop';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Section from './ui/Section.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import { DEVICE_KIND_LABELS, DEVICE_KINDS, deviceKind, type DeviceKind } from '../lib/deviceKind.svelte';

  // 設定の「この端末の種類」。この端末だけの設定（サーバーには送らない）
  const icons: Record<DeviceKind, typeof Smartphone> = { smartphone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor };
  const options = DEVICE_KINDS.map((k) => ({ value: k, label: DEVICE_KIND_LABELS[k], icon: icons[k] }));
</script>

<Section title="この端末の種類" class="settings-device-kind">
  <SegmentedButton
    class="settings-device-kind-picker"
    label="この端末の種類"
    {options}
    value={deviceKind.value}
    onchange={(v) => deviceKind.set(v)}
  />
  <p class="muted settings-device-kind-note">この端末だけの設定です。ほかの端末とは共有しません</p>
</Section>

<style>
  .settings-device-kind-note {
    margin: 8px 0 0;
    font-size: 13px;
  }
</style>
