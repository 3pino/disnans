// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * あとで読む: メッセージの操作とタイムラインの例（API v9）。
 *
 * - メッセージを長押し（デスクトップはホバー）して「あとで読む」を選ぶと、そのメッセージを覚える（もう一度で外す）
 * - コマンド「あとで読む」（パレット・`/read-later`）で、覚えたメッセージをパネルに並べる。
 *   本体のメッセージ表示のままなので、リアクションや返信もそのまま使える。パネルを開いたまま追加・解除すると並びも変わる
 */

const { Plugin } = disnans;

/** 覚えておく件数の上限 */
const MAX_ITEMS = 100;

export default class ReadLater extends Plugin {
  /** 覚えているメッセージの ID（新しい順） */
  /** @type {string[]} */
  ids = [];
  /** @type {Disnans.TimelineHandle | null} */
  panel = null;

  async onload() {
    const saved = await this.loadData();
    if (Array.isArray(saved)) this.ids = saved.filter((x) => typeof x === 'string').slice(0, MAX_ITEMS);

    this.addMessageAction({
      id: 'toggle',
      label: 'あとで読む',
      icon: 'bookmark',
      placement: 'both',
      // カード（本文のないメッセージ）は対象外
      when: (msg) => !msg.card,
      run: (msg) => this.toggle(msg.id),
    });

    this.addCommand({
      id: 'open',
      name: 'あとで読む',
      icon: 'bookmark',
      slash: 'read-later',
      description: '「あとで読む」にしたメッセージを開く',
      run: () => this.open(),
    });
  }

  /** @param {string} id */
  toggle(id) {
    const had = this.ids.includes(id);
    this.ids = had ? this.ids.filter((x) => x !== id) : [id, ...this.ids].slice(0, MAX_ITEMS);
    void this.saveData(this.ids);
    // 開いているパネルの並びも更新する
    this.panel?.update({ messageIds: this.ids });
    disnans.ui.toast(had ? 'あとで読むから外しました' : 'あとで読むに入れました');
  }

  open() {
    if (this.panel && !this.panel.closed) this.panel.close();
    // 読み込み済みのメッセージだけが並ぶ（古くて読み込まれていないものは、スクロールで読み込まれると出る）
    this.panel = this.openTimeline({
      title: 'あとで読む',
      icon: 'bookmark',
      messageIds: this.ids,
      empty: 'あとで読むに入れたメッセージはありません。メッセージを長押しして追加できます。',
      onClose: () => {
        this.panel = null;
      },
    });
  }
}
