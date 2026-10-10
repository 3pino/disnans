<script lang="ts">
  import ThreadListItem from './ThreadListItem.svelte';
  import { threads } from '../lib/stores/threads.svelte';
</script>

<div class="thread-list">
  <ul class="thread-list-items">
    {#each threads.list as t (t.root.id)}
      <li class="thread-list-entry"><ThreadListItem thread={t} /></li>
    {:else}
      <li class="thread-list-empty muted">
        {#if !threads.loaded}読み込み中…{:else}まだスレッドはありません。メッセージの「スレッドを立てる」から始められます{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .thread-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .thread-list-items {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .thread-list-empty {
    padding: 12px 8px;
    font-size: 13px;
  }
</style>
