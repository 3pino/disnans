// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ボット: プラグインからボットとしてメッセージを投稿する最小の例（API v5 の postMessage）。
 *
 * - `/bot <text>` ............ <text> を、このプラグインの名前のボットとして投稿する
 * - `/bot-as <name> <text>` .. <name> という名前のボットとして投稿する
 *
 * 投稿した人（author）は自分のままで、メッセージに bot の印が付く。
 * 入力したのがスレッドならそのスレッドに、メインチャットならメインチャットに投稿する。
 */

const { Plugin, ui } = disnans;

/**
 * `/bot-as` の引数を、名前と本文に分ける。名前は最初の空白まで。
 * @param {string} args
 * @returns {{ name: string; text: string } | null}
 */
function splitNameAndText(args) {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
  return m ? { name: m[1], text: m[2].trim() } : null;
}

export default class BotPlugin extends Plugin {
  onload() {
    this.addCommand({
      id: 'say',
      name: 'ボットとして投稿する',
      slash: 'bot',
      description: 'ボットとして投稿する',
      args: '<本文>',
      run: (ctx) => this.say(ctx.args, ctx.threadId),
    });
    this.addCommand({
      id: 'say-as',
      name: '名前を付けてボットとして投稿する',
      slash: 'bot-as',
      description: '名前を付けてボットとして投稿する',
      args: '<名前> <本文>',
      run: (ctx) => {
        const parsed = splitNameAndText(ctx.args);
        if (!parsed) {
          ui.toast('/bot-as <名前> <本文> の形で入力してください', 'error');
          return;
        }
        return this.say(parsed.text, ctx.threadId, parsed.name);
      },
    });
  }

  /**
   * @param {string} text
   * @param {string | null} threadId
   * @param {string} [name]
   */
  async say(text, threadId, name) {
    if (!text.trim()) {
      ui.toast('本文を入力してください', 'error');
      return;
    }
    try {
      await this.postMessage({ body: text, threadId, name });
    } catch (e) {
      ui.toast(`投稿できませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
}


