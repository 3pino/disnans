<script lang="ts">
  // 通知の並び。並びと閉じ方は土台（@3pino/app-kit-web/shell/Toasts.svelte）。ここは disnans の送り主のアイコンと ui の通知を渡すだけ
  import Toasts from '@3pino/app-kit-web/shell/Toasts.svelte';
  import AuthorAvatar from './AuthorAvatar.svelte';
  import { ui, type ToastAvatar } from '../lib/stores/ui.svelte';
</script>

<Toasts toasts={ui.toasts} dismiss={(id) => ui.dismiss(id)}>
  {#snippet avatar(a: ToastAvatar)}
    <AuthorAvatar author={a.author} user={a.user} id={a.id} size={28} />
  {/snippet}
</Toasts>
