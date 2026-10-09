<script lang="ts">
  import type { User } from '../lib/protocol/User';
  import { hueOf, initials } from '../lib/format';

  let { user, id, size = 36 }: { user?: User; id: string; size?: number } = $props();
  let broken = $state(false);
  const name = $derived(user?.display_name ?? '?');
</script>

{#if user?.avatar_url && !broken}
  <img
    class="avatar"
    src={user.avatar_url}
    alt=""
    width={size}
    height={size}
    style:width="{size}px"
    style:height="{size}px"
    onerror={() => (broken = true)}
  />
{:else}
  <span
    class="avatar initials"
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
  .initials {
    display: grid;
    place-items: center;
    background: oklch(var(--avatar-l) 0.08 var(--h));
    color: var(--bg);
    font-weight: 700;
    user-select: none;
  }
</style>
