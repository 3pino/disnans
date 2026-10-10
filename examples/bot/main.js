// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ボット: プラグインからボットとしてメッセージを投稿する最小の例（API v6 の postMessage）。
 *
 * - `/bot <text>` ............ <text> を、このプラグインの名前のボットとして投稿する
 * - `/bot-as <name> <text>` .. <name> という名前のボットとして投稿する
 * - `/bot-notify [秒] <text>`  通知を送るように投稿する（自分にも通知が届く）。最初の数字は、
 *                              投稿までに待つ秒数（上限 60 秒）。アプリを裏に回して通知を確かめられる
 *
 * 投稿した人（author）は自分のままで、メッセージに bot の印が付く。
 * 入力したのがスレッドならそのスレッドに、メインチャットならメインチャットに投稿する。
 * `/bot` と `/bot-as` は通知を送らない（silent）。
 */

const { Plugin, ui } = disnans;

/** `/bot-notify` で待てる秒数の上限 */
const MAX_DELAY_SECONDS = 60;

/**
 * `/bot-as` の引数を、名前と本文に分ける。名前は最初の空白まで。
 * @param {string} args
 * @returns {{ name: string; text: string } | null}
 */
function splitNameAndText(args) {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
  return m ? { name: m[1], text: m[2].trim() } : null;
}

/**
 * `/bot-notify` の引数を、待つ秒数と本文に分ける。最初の語が数字なら秒数（上限は MAX_DELAY_SECONDS）。
 * @param {string} args
 * @returns {{ seconds: number; text: string }}
 */
function splitDelayAndText(args) {
  const m = /^(\d+)(?:\s+([\s\S]*))?$/.exec(args.trim());
  if (!m) return { seconds: 0, text: args.trim() };
  return { seconds: Math.min(Number(m[1]), MAX_DELAY_SECONDS), text: (m[2] ?? '').trim() };
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
    this.addCommand({
      id: 'say-notify',
      name: '通知付きでボットとして投稿する',
      slash: 'bot-notify',
      description: '通知付きでボットとして投稿する（自分にも通知が届く）',
      args: '[秒] <本文>',
      run: (ctx) => this.sayNotify(ctx.args, ctx.threadId),
    });
  }

  /**
   * 通知を送るように投稿する。秒数が指定されていれば、その間待ってから投稿する
   * （待っている間に、アプリを裏に回して通知を確かめられる）。
   * @param {string} args
   * @param {string | null} threadId
   */
  async sayNotify(args, threadId) {
    const { seconds, text } = splitDelayAndText(args);
    if (!text) {
      ui.toast('本文を入力してください', 'error');
      return;
    }
    if (seconds > 0) {
      ui.toast(`${seconds} 秒後に投稿します`);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    return this.say(text, threadId, undefined, true);
  }

  /**
   * @param {string} text
   * @param {string | null} threadId
   * @param {string} [name]
   * @param {boolean} [notify]
   */
  async say(text, threadId, name, notify = false) {
    if (!text.trim()) {
      ui.toast('本文を入力してください', 'error');
      return;
    }
    try {
      await this.postMessage({ body: text, threadId, name, notify });
    } catch (e) {
      ui.toast(`投稿できませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
}


