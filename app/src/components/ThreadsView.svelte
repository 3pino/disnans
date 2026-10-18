<script lang="ts">
  import ThreadList from './ThreadList.svelte';

  // スレッドの一覧。ナビゲーションバーの Threads タブで開く（広い画面ではチャットと同じ場所に、狭い画面では全画面で出す）。
  // 以前の大画面のサイドバーとモバイルの一覧を、この1つにまとめている
</script>

<section id="threads-view" class="threads-view">
  <header class="top-bar"></header>

  <div class="scroll threads-view-body">
    <h2 class="threads-view-title">スレッド</h2>
    <ThreadList />
  </div>
</section>

<style>
  .threads-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .threads-view-body {
    flex: 1;
    min-height: 0;
    padding-bottom: 12px;
  }
  .threads-view-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 20px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
</style>
