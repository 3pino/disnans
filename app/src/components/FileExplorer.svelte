<script lang="ts">
  import KitFileExplorer from '@3pino/explorer-kit/FileExplorer.svelte';
  import { explorer } from '../lib/explorer/instance';

  // 共有フォルダのエクスプローラー。画面は共有の部品（@3pino/explorer-kit。disrect と同じもの）で、
  // ここは Disnans の置き場所と本体の機能（lib/explorer/instance.ts）を渡すだけ。
</script>

<KitFileExplorer {explorer} />
