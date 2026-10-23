<script lang="ts">
  import type { RecentImage } from '../lib/recentImages';

  // 最近の画像の 1 枚の中身。サムネイルがあればそれを、無ければ原本から blob URL を作って描く。
  // 描けない（WebView が対応しない形式など）ときは、名前だけの枠にする
  let { image }: { image: RecentImage } = $props();

  let src = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    failed = false;
    if (image.thumbUrl) {
      src = image.thumbUrl;
      return;
    }
    src = null;
    let alive = true;
    let url: string | null = null;
    void image.preview().then(
      (u) => {
        if (!alive) {
          URL.revokeObjectURL(u);
          return;
        }
        url = u;
        src = u;
      },
      () => {
        if (alive) failed = true;
      },
    );
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

{#if src && !failed}
  <img class="recent-thumb-img" {src} alt="" loading="lazy" decoding="async" onerror={() => (failed = true)} />
{:else}
  <span class="recent-thumb-name">{image.name}</span>
{/if}

<style>
  .recent-thumb-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .recent-thumb-name {
    display: block;
    width: 100%;
    height: 100%;
    padding: var(--space-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    text-align: center;
  }
</style>
