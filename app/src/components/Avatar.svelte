<script lang="ts">
  import type { User } from '../lib/protocol/User';
  import { hueOf, initials } from '../lib/format';
  import { avatarSrc } from '../lib/config';

  let { user, id, size = 36 }: { user?: User; id: string; size?: number } = $props();
  const url = $derived(user?.avatar_url ?? null);
  // 読み込めなかった URL（変わったら、もう一度読み込んでみる）
  let brokenUrl = $state<string | null>(null);
  const name = $derived(user?.display_name ?? '?');
</script>

{#if url && url !== brokenUrl}
  <img
    class="avatar"
    src={avatarSrc(url)}
    alt=""
    width={size}
    height={size}
    style:width="{size}px"
    style:height="{size}px"
    onerror={() => (brokenUrl = url)}
  />
{:else}
  <span
    class="avatar avatar-initials"
    aria-hidden="true"
    style:width="{size}px"
    style:height="{size}px"
    style:font-size="{Math.round(size * 0.42)}px"
    style:--h={hueOf(id)}
  >
    {initials(name)}
  </span>
{/if}

<style>
  .avatar {
    border-radius: 50%;
    flex: none;
    object-fit: cover;
    display: block;
  }
  .avatar-initials {
    display: grid;
    place-items: center;
    background: oklch(var(--avatar-l) 0.08 var(--h));
    color: var(--bg);
    font-weight: 700;
    user-select: none;
  }
</style>
