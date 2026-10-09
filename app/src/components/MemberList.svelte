<script lang="ts">
  import Avatar from './Avatar.svelte';
  import { client } from '../lib/stores/client.svelte';
</script>

<ul class="members">
  {#each client.userList as u (u.id)}
    <li title={u.login_name}>
      <Avatar user={u} id={u.id} size={24} />
      <span class="name">{u.display_name}</span>
      {#if u.id === client.me?.id}<span class="you">あなた</span>{/if}
    </li>
  {/each}
</ul>

<style>
  .members {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: var(--radius-sm);
    font-size: 14px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .you {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
