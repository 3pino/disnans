import Copy from '@lucide/svelte/icons/copy';
import MessageSquare from '@lucide/svelte/icons/message-square';
import Pencil from '@lucide/svelte/icons/pencil';
import Reply from '@lucide/svelte/icons/reply';
import SmilePlus from '@lucide/svelte/icons/smile-plus';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { authorOf, isOwnMessage } from './author';
import { copyText } from './clipboard';
import { registerMessageAction, type MessageActionContext } from './messageActions.svelte';
import { client } from './stores/client.svelte';
import { reply } from './stores/reply.svelte';
import { ui } from './stores/ui.svelte';

// 本体のメッセージの操作。プラグインの項目（addMessageAction）と同じ仕組みで並べる。
// 並び順は 100 刻み。プラグインの項目は 1000、削除は 9000（いちばん最後）

/** 送信中の仮表示（まだサーバーに届いていない）。操作は出さない */
function isPending(ctx: MessageActionContext): boolean {
  return 'client_id' in ctx.message;
}

/** 自分の発言でカードでもボットでもない（本文を編集できる） */
function canEdit({ message }: MessageActionContext): boolean {
  return isOwnMessage(message, client.me?.id) && !message.card && !authorOf(message, client.users).isBot;
}

export async function removeMessage(message: MessageActionContext['message']): Promise<void> {
  const ok = await ui.confirm({
    title: 'メッセージを削除しますか？',
    body: message.thread
      ? 'このメッセージから始まったスレッドの返信もすべて削除されます。元には戻せません。'
      : message.card
        ? 'このカードのセッション（プラグインの状態）も削除されます。元には戻せません。'
        : '削除すると元には戻せません。',
    okLabel: '削除',
    danger: true,
  });
  if (ok) client.deleteMessage(message);
}

let done = false;

/** 本体の項目を登録する（何度呼んでもよい） */
export function registerCoreMessageActions(): void {
  if (done) return;
  done = true;
  registerMessageAction({
    id: 'core:reaction',
    label: 'リアクション',
    icon: SmilePlus,
    placement: 'toolbar',
    order: 100,
    when: (c) => !isPending(c),
    run: (c) => c.openPicker(c.anchor),
  });
  registerMessageAction({
    id: 'core:reply',
    label: '返信',
    icon: Reply,
    placement: 'both',
    order: 200,
    when: (c) => !isPending(c),
    run: (c) => reply.set(c.place, c.message),
  });
  registerMessageAction({
    id: 'core:thread',
    label: (c) => (c.message.thread ? 'スレッドを開く' : 'スレッドを立てる'),
    icon: MessageSquare,
    placement: 'both',
    order: 300,
    when: (c) => !c.inThread && !isPending(c) && c.message.thread_id === null,
    run: (c) => client.openThreadFrom(c.message),
  });
  registerMessageAction({
    id: 'core:copy',
    label: 'コピー',
    icon: Copy,
    placement: 'both',
    order: 400,
    when: (c) => !isPending(c) && !c.message.card && c.message.body.length > 0,
    run: async (c) => {
      if (await copyText(c.message.body)) ui.toast('コピーしました');
      else ui.toast('コピーできませんでした', 'error');
    },
  });
  registerMessageAction({
    id: 'core:edit',
    label: '編集',
    icon: Pencil,
    placement: 'both',
    order: 500,
    when: (c) => !isPending(c) && canEdit(c),
    run: (c) => {
      ui.editing = c.message.id;
    },
  });
  registerMessageAction({
    id: 'core:delete',
    label: '削除',
    icon: Trash2,
    placement: 'both',
    danger: true,
    order: 9000,
    // 自分が投稿者のもの（ボットの発言も、自分が実行したものなら）
    when: (c) => !isPending(c) && !!client.me && client.me.id === c.message.author_id,
    run: (c) => removeMessage(c.message),
  });
}
