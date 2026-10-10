<script lang="ts">
  import Avatar from './Avatar.svelte';
  import Icon from './ui/Icon.svelte';
  import type { AuthorView } from '../lib/author';
  import type { User } from '../lib/protocol/User';
  import { avatarSrc } from '../lib/config';
  import { pluginHost } from '../lib/plugins/host.svelte';

  // 投稿者のアイコン。人は Avatar（画像かイニシャル）。ボットは、プラグインのアイコンを丸く描く
  // （プラグインのアイコンのファイルは認証付きで取るので、画像の URL ではなく登録済みのアイコンを使う）
  let { author, user, id, size = 36 }: { author: AuthorView; user?: User; id: string; size?: number } = $props();
  const iconName = $derived(author.botPlugin ? pluginHost.pluginIcon(author.botPlugin) : null);
</script>

{#if author.isBot}
  <span class="author-bot-avatar" aria-hidden="true" style:width="{size}px" style:height="{size}px">
    {#if author.avatarUrl}
      <img src={avatarSrc(author.avatarUrl)} alt="" width={size} height={size} />
    {:else if iconName}
      <Icon icon={iconName} size={Math.round(size * 0.6)} />
    {/if}
  </span>
{:else}
  <Avatar {user} {id} {size} />
{/if}

<style>
  .author-bot-avatar {
    display: grid;
    place-items: center;
    flex: none;
    overflow: hidden;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-muted);
  }
  .author-bot-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
