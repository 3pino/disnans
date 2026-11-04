<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Camera from '@lucide/svelte/icons/camera';
  import Image from '@lucide/svelte/icons/image';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import SettingRow from './ui/SettingRow.svelte';
  import SegmentedButton from './ui/SegmentedButton.svelte';
  import Button from './ui/Button.svelte';
  import { FPS_OPTIONS, COLOR_MODES, formatBytes } from '../lib/call/screen/codec';
  import { encodePreview, loadSnapshotCanvas, newCanvas, type PreviewResult } from '../lib/call/screen/preview';
  import type { ScreenSettingsPort, ScreenSettingsValue, ScreenSnapshot } from '../lib/call/screen/types';

  // 設定の「通話」の画面共有の行（FPS・画質・色数）。保存は設定の値（port）に渡す。
  // 変えた設定は、次に共有を始めたときから使う（共有中の画面は変わらない。許可のダイアログも出し直さない）。
  // 「プレビュー」は、いまの画面を 1 枚だけ撮り（押したときだけ。開いただけでは撮らない・共有は始めない）、今の設定で符号化して見せる。
  // 設定を変えたら、撮ってある 1 枚を符号化し直す（撮り直さない）。1 フレームの大きさと、動き続けたときの帯域の見積もりを出す。

  let { settings, snapshot }: { settings: ScreenSettingsPort; snapshot: (() => Promise<ScreenSnapshot>) | null } = $props();

  // 設定の変更を読むための版（port の subscribe で上げる）
  let version = $state(0);
  $effect(() => settings.subscribe(() => version++));
  const value = $derived.by((): ScreenSettingsValue => {
    void version;
    return settings.value;
  });

  let preview = $state.raw<PreviewResult | null>(null);
  let previewing = $state(false);
  let previewError = $state('');

  // 撮った 1 枚（撮ったあとだけある）。撮り直しと、アンマウントの後の完了は、世代の番号で捨てる
  let shot: { canvas: unknown; width: number; height: number } | null = null;
  let shotSeq = 0;
  let alive = true;

  // 設定が変わったら、撮ってある 1 枚を符号化し直す（撮り直さない）
  $effect(() => {
    const v = value;
    untrack(() => encode(v));
  });

  function encode(v: ScreenSettingsValue): void {
    if (!shot || !alive) return;
    try {
      preview = encodePreview(shot.canvas, shot, v, newCanvas);
      previewError = '';
    } catch (e) {
      console.error('プレビューを作れませんでした', e);
      preview = null;
      previewError = 'プレビューを作れませんでした';
    }
  }

  async function takePreview(): Promise<void> {
    if (!snapshot || previewing) return;
    const my = ++shotSeq;
    previewing = true;
    previewError = '';
    try {
      const got = await snapshot();
      if (!alive || my !== shotSeq) return;
      const loaded = await loadSnapshotCanvas(got.dataUrl);
      if (!alive || my !== shotSeq) return;
      shot = { canvas: loaded.canvas, width: loaded.width, height: loaded.height };
      encode(untrack(() => settings.value));
    } catch (e) {
      if (!alive || my !== shotSeq) return;
      console.error('画面のプレビューを撮れませんでした', e);
      shot = null;
      preview = null;
      previewError = 'この環境では画面のプレビューを撮れません';
    } finally {
      if (my === shotSeq) previewing = false;
    }
  }

  onDestroy(() => {
    alive = false;
    shotSeq++;
    shot = null;
    preview = null;
  });

  const fpsOptions = FPS_OPTIONS.map((n) => ({ value: String(n), label: `${n} fps` }));
  const qualityOptions = [
    { value: 'p480', label: '480p' },
    { value: 'p720', label: '720p' },
    { value: 'p1080', label: '1080p' },
  ];
  const colorOptions = Object.entries(COLOR_MODES).map(([value, label]) => ({ value, label }));

  function patch<K extends keyof ScreenSettingsValue>(key: K, v: ScreenSettingsValue[K]): void {
    settings.patch({ [key]: v } as Partial<ScreenSettingsValue>);
  }
</script>

<SettingRow name="画面共有のフレームレート" description="次に共有を始めたときから使われます" icon={Monitor}>
  {#snippet control()}
    <SegmentedButton label="画面共有のフレームレート" options={fpsOptions} value={String(value.fps)} onchange={(v) => patch('fps', Number(v) === 20 ? 20 : 5)} />
  {/snippet}
</SettingRow>

<SettingRow name="画面共有の画質" description="解像度と画質の目安（次に共有を始めたときから）" icon={Image}>
  {#snippet control()}
    <SegmentedButton label="画面共有の画質" options={qualityOptions} value={value.quality} onchange={(v) => patch('quality', v as ScreenSettingsValue['quality'])} />
  {/snippet}
</SettingRow>

<SettingRow name="画面共有の色数" description="少ない色ほど軽くなります（次に共有を始めたときから）" icon={Camera}>
  {#snippet control()}
    <SegmentedButton label="画面共有の色数" options={colorOptions} value={value.color} onchange={(v) => patch('color', v as ScreenSettingsValue['color'])} />
  {/snippet}
</SettingRow>

{#if snapshot}
  <SettingRow name="画面のプレビュー" description="いまの画面を 1 枚だけ撮り、今の設定で見せます。共有は始まりません">
    {#snippet control()}
      <Button onclick={() => void takePreview()} disabled={previewing} icon={RefreshCw}>{previewing ? '撮っています…' : preview ? '撮り直す' : 'プレビューを撮る'}</Button>
    {/snippet}
  </SettingRow>
  {#if previewError}
    <p class="muted screen-share-settings-note" role="status">{previewError}</p>
  {:else if preview}
    <figure class="screen-share-settings-preview">
      <img src={preview.src} alt="今の設定での見え方" draggable="false" />
      <figcaption class="muted screen-share-settings-size" role="status">
        {preview.width}×{preview.height}・1 枚 約 {formatBytes(preview.imageBytes)}・動き続けると約 {formatBytes(preview.bytesPerSec)}/秒{preview.capped ? '（サーバーの上限まで。間隔が空きます）' : ''}
      </figcaption>
    </figure>
  {/if}
{/if}

<style>
  .screen-share-settings-preview {
    margin: var(--space-4) 0 0;
    padding: 0 var(--space-6);
  }
  .screen-share-settings-preview img {
    display: block;
    max-width: 100%;
    max-height: 240px;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
  }
  .screen-share-settings-size {
    margin-top: var(--space-2);
  }
  .screen-share-settings-note {
    margin: var(--space-3) var(--space-6) 0;
  }
</style>
