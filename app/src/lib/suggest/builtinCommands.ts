import { client } from '../stores/client.svelte';
import { MAX_BODY } from '../errors';
import { registerSlashCommand } from '../slashCommands.svelte';

// 本体のコマンド。import したときに1回だけ登録する

registerSlashCommand({
  name: 'thread',
  description: 'メッセージを送り、そこからスレッドを始める',
  args: '<本文>',
  run({ args, threadId }) {
    if (threadId !== null) throw new Error('スレッドの中では使えません');
    if (!args) throw new Error('本文を入力してください（/thread <本文>）');
    if (args.length > MAX_BODY) throw new Error(`メッセージが長すぎます（${args.length} / ${MAX_BODY}文字）`);
    client.sendMessage({ threadId: null, body: args, attachments: [], startThread: true });
  },
});
