# コマンド・＋メニュー・メッセージの操作

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

### コマンド（パレット・ホットキー・スラッシュコマンド）

`addCommand` で足したコマンドは、次の3つから実行できます。

- **コマンドパレット**（デスクトップ。既定は Ctrl+P）: 名前で絞り込んで Enter
- **ホットキー**（デスクトップ。Android では効きません）: `hotkey` は既定のキーで、利用者は **設定 → ホットキー** で変えたり外したりできます
- **スラッシュコマンド**: `slash` を付けると、入力欄の `/名前` にもなります（補完に出ます）

```js
this.addCommand({
  id: 'roll',                    // プラグインの中で一意。利用者のホットキーの設定は `dice:roll` で保存される
  name: 'サイコロを用意する',      // パレット・設定の一覧に出る名前
  icon: 'dice-cube',             // アイコン（addIcon で登録したもの。省略するとプラグインのアイコン）
  hotkey: 'Mod+Shift+D',         // 既定のホットキー。Mod は Ctrl
  slash: 'dice',                 // `/dice`。英小文字・数字・ハイフン。省略するとスラッシュコマンドにしない
  description: 'サイコロを振る',   // 補完に出る説明（省略すると name）
  args: '[個数]d[面数]',           // 引数の書き方のヒント
  // 引数の候補。input はコマンド名のあとに打った文字列
  suggestArgs: (input) => {
    const q = input.trim().toLowerCase();
    return PRESETS.filter((p) => p.value.startsWith(q)); // [{ value: '2d6', description: 'サイコロ2個' }, ...]
  },
  // ctx.args: `/dice 2d6` なら '2d6'（前後の空白は除く）。ホットキー・パレットからは ''
  // ctx.via: 'slash' / 'hotkey' / 'palette'
  run: (ctx) => this.prepare(ctx.args),
});
```

ダイスの `prepare` は、`args` が空なら設定の「既定のサイコロ」を使います。
ホットキーもスラッシュコマンドもないコマンド（ダイスの「20面のサイコロを用意する」）は、パレットから実行します（利用者は設定でホットキーを付けられます）。

- `/dice 2d6` のように送信すると、メッセージとしては送らずに `run` を呼びます
- 入力の誤りは `disnans.ui.toast('…', 'error')` で知らせます。`run` が例外を投げた（reject した）ときも、本体がエラーのトーストを出します
- 候補（`Suggestion`）は `{ value, label?, description? }`。`value` が入力欄に入ります
- `hotkey` が読めない・`slash` の名前が正しくないときは、その部分を外して登録し、設定のプラグイン一覧にエラーを出します
- ホットキーは、入力欄で文字を打っている間は Ctrl・Alt・Meta を含むもの（と F1〜F12）だけが効きます
- 本体のコマンド（設定を開く・チャットを開く・コマンドパレットなど）と同じキーにすると、設定のホットキーの一覧に警告が出ます。先に登録されたもの（本体のもの）が優先されます

#### addSlashCommand（API v1 の書き方）

スラッシュコマンドだけを足す、v1 からある書き方です。いまも使えます（パレット・ホットキーには出ません）。

```js
this.addSlashCommand({
  name: 'hello',
  description: 'あいさつする',
  icon: 'hand',        // 省略するとプラグインのアイコン
  args: '[名前]',       // 任意
  suggestArgs: (input) => [], // 任意
  run: ({ args }) => disnans.ui.toast(`こんにちは ${args}`),
});
```

### ＋メニュー

```js
this.addComposerAction({
  id: 'roll-2d6',
  label: 'サイコロ（2d6）',
  icon: 'dices', // アイコンの名前（Lucide の名前。省略するとプラグインのアイコン）
  run: () => this.prepare('2d6'),
});
```

`icon` は**アイコンの名前**です（Lucide の名前・`disnans-logo`・`addIcon` で登録した名前）。
独自の SVG を使うときは、先に `this.addIcon('dice-cube', '<path .../>')` で登録してから名前で指定します（→ [PLUGIN_UI.md](ui.md#アイコン)）。
ダイスは `onload` の最初に、立方体のサイコロを `dice-cube` として登録し、`/dice` のコマンド・パネルの上部・タブ・カードで使っています。

```js
// <svg> の中身だけを渡すと、既定は fill="none" stroke="currentColor" stroke-width="2"（Lucide と同じ）
this.addIcon('dice-cube', '<path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>…');
```

### メッセージの操作とタイムライン（v9）

メッセージを長押ししたときのメニュー（モバイル）と、デスクトップでホバーしたときのツールバーに、項目を足せます。本体の項目（返信・コピー・編集・削除、ツールバーのリアクション）も同じ仕組みで並んでいて、`order`（小さいほど前）で並びが決まります。

```js
this.addMessageAction({
  id: 'later',
  label: 'あとで読む',
  icon: 'bookmark',          // アイコンの名前。省略するとプラグインのアイコン
  placement: 'both',         // 'menu'（長押し）| 'toolbar'（ホバー）| 'both'。省略は both
  order: 1000,               // 省略は 1000。本体は 返信 200・コピー 400・編集 500・削除 9000（リアクションはツールバー先頭の 100）
  danger: false,             // true で注意の色
  when: (msg) => !msg.card,                // 省略すると常に出す。送信中の仮表示には出ない
  run: (msg) => { /* ... */ },
});
```

`msg` は本体のメッセージ（`id` `author_id` `reply_to` `body` `reactions` `created_at` `edited_at` `card` `bot` など。型は `Disnans.Message`）。`when` が例外を投げた項目は出さず、`run` の例外はトーストで知らせます。

`openTimeline` は、メッセージの集合を**本体のメッセージ表示**（リアクション・返信の引用・長押しメニューもそのまま）で、パネル（デスクトップは右、モバイルは全画面）に並べます。返信のツリーと同じ枠です。

```js
const panel = this.openTimeline({
  title: 'あとで読む',
  icon: 'bookmark',
  messageIds: ['…', '…'],   // 本体が読み込み済みのメッセージだけが並ぶ（読み込まれていない・削除されたものは飛ばす）。リアクション・編集は常に最新
  // messages: [msg, …],    // ID の代わりにメッセージそのものを渡してもよい（どちらか一方）。読み込み済みなら最新に差し替わる
  depths: { '<id>': 1 },    // 字下げの深さ（省略は 0）。ツリーを見せたいときに
  empty: '空のときの文言',
  onClose: () => {},        // 閉じたとき（利用者が閉じた・別のパネルに替わった・close()・プラグインを外した）に 1 回
});
panel.update({ messageIds: [...] }); // 題名・アイコン・中身・字下げを差し替える
panel.close();
```

パネルは同時に 1 つ（別のパネルを開くと前のものは閉じる）。本体の「返信のツリー」（返信を受けたメッセージの本文の末尾のアイコン）も同じパネルです。
