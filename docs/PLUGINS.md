# プラグインの作り方

disnans のプラグインは、Obsidian のプラグインに近い仕組みです。JS のファイルを1つ書けば動き、ボタン1つで全員に配れます。
このガイドは、実例の **ダイス**（[`examples/dice/`](../examples/dice/)）を題材に説明します。
ダイスはホスト API をひととおり使っているので、迷ったら `main.js` を読むのが早道です（どの API をどこで使っているかは、ファイルの先頭にまとめてあります）。

| ダイスでできること | 使っている API |
|---|---|
| `/dice 2d6` でサイコロを用意する（補完に候補が出る）。Ctrl+Shift+D・コマンドパレットからも | `addCommand`（`icon`・`hotkey`・`slash`・`args`・`suggestArgs`） |
| コマンドパレットの「20面のサイコロを用意する」 | `addCommand`（ホットキーもスラッシュコマンドもないもの） |
| 「＋」メニューの「サイコロ（2d6）」 | `addComposerAction`（Lucide のアイコン `dices`） |
| 立方体のサイコロのアイコン | `icon.svg`（プラグインのアイコン）、`addIcon`（`dice-cube`）、manifest の `icon`（予備） |
| パネルの画面（「結果」「使い方」のタブ） | `registerView` / `openView`、`View.title` / `View.icon`、`panel.setTitle` / `setIcon`、`ui.navbar` / `ui.button` / `ui.icon` / `ui.divider` |
| 振ると全員の画面に結果が出て、カードが書き換わる | `sessions.create`、`session.update`（楽観ロックと `VersionConflictError` のやり直し）、`session.onChange` |
| 振っている間、見ている人の画面でもサイコロが揺れる | `session.emit` / `session.on`、`registerInterval`（演出のタイマー）、`registerDomEvent`（裏に回ったら演出をやめる） |
| チャットのカードの見た目 | `registerCardRenderer` |
| 設定（既定のサイコロ・振る前の確認・出目の演出・初期値に戻す） | `addSettingTab`、`loadData` / `saveData`、`ui.setting` / `ui.segmented` / `ui.toggle` / `ui.confirm` |
| スタイル | `styles.css`（本体の CSS 変数） |

使っていないのは `notify` だけです（カードの書き換えで足りるため。→ [通知](#通知)）。

- 設計: [`SPEC.md`](../SPEC.md) の 3.3 と 9章
- 型定義: [`packages/plugin-sdk/index.d.ts`](../packages/plugin-sdk/index.d.ts)（API の細かい説明はここが正）
- UI 部品（`disnans.ui`）とアイコン: [`PLUGIN_UI.md`](PLUGIN_UI.md)
- ホスト API のバージョン: **9**（`addCommand` の `icon`・`slash`・`run(ctx)` は 2 から。`broadcast` / `onBroadcast`・`addStatusBarItem`・`holdBackground` は 3 から。`holdBackground` の通知のボタン `actions` / `onAction` と `update()` は 4 から。`disnans.audio` は 5、`postMessage` の `notify` と `openSettings` は 6、`disnans.call`（通話の拡張）は 7 から、`addMessageAction` / `openTimeline` は 9 から）
- 通話（ボイスチャット）は**アプリ本体の機能**です。画面共有などの拡張は `disnans.call` で作れます（→ [通話の拡張 API](#通話の拡張-apidisnanscallv8)）

## 目次

1. [5分で動かす](#5分で動かす)
2. [manifest.json](#manifestjson)
3. [main.js の書き方](#mainjs-の書き方)
4. [ライフサイクル](#ライフサイクル)
5. [ホスト API](#ホスト-api)
6. [見た目（CSS）](#見た目css)
7. [TypeScript で書く](#typescript-で書く)
8. [配布・更新・削除と、端末ごとのオンオフ](#配布更新削除と端末ごとのオンオフ)
9. [注意点](#注意点)

---

## 5分で動かす

### 1. 開発用フォルダを決める

PC 版（Windows / Linux）の **設定 → プラグイン → 開発用フォルダ** で、フォルダを選びます（例: `~/disnans-plugins`）。
このフォルダの中のプラグインは、**自分の端末でだけ**動きます。

> Android には開発用フォルダはありません。ブラウザー版（開発用）では、ファイルを選んで直接配布できます。

### 2. プラグインのフォルダを作る

```
~/disnans-plugins/
└── hello/
    ├── manifest.json
    └── main.js
```

ダイスを試すなら、`examples/dice/`（`manifest.json`・`main.js`・`styles.css`・`icon.svg`）をそのまま開発用フォルダにコピーしてもかまいません。

### 3. manifest.json と main.js を書く

```json
{
  "id": "hello",
  "name": "あいさつ",
  "version": "0.1.0",
  "description": "/hello であいさつする",
  "author": "あなたの名前",
  "minApiVersion": 1
}
```

```js
// @ts-check
const { Plugin } = disnans;

export default class HelloPlugin extends Plugin {
  onload() {
    this.addSlashCommand({
      name: 'hello',
      description: 'あいさつする',
      run: () => disnans.ui.toast(`こんにちは、${this.app.me.display_name} さん`),
    });
  }
}
```

### 4. 試す（ホットリロード）

アプリが自動で読み込みます。入力欄で `/` と打つと `/hello` が補完に出るので、送信してみてください。
`main.js` や `styles.css` を保存すると、アプリが自動で読み込み直します（古いほうの `onunload()` を呼んでから、新しいほうを読み込む）。

読み込みに失敗したり、`onload()` で例外が出たりしたときは、設定のプラグイン一覧にエラーが出ます。本体は動き続けます。
細かいことは開発者ツール（DevTools）のコンソールで見られます。

### 5. 配布する

**設定 → プラグイン** の一覧で、そのプラグインの **[配布]** を押し、**みんなに配布** か **自分だけに配布** を選びます。
サーバーに上がり、つながっている全員（自分だけなら、自分のすべての端末）のクライアントで動き始めます。
チャットにお知らせは流れません。

直したら、`version` を上げてもう一度 [配布] を押すと更新になります。

---

## manifest.json

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | ○ | 英小文字・数字・ハイフン（2〜32文字）。サーバー内で一意。同じ `id` を配布すると上書き（更新）になる |
| `name` | ○ | 表示名（「ダイス」） |
| `version` | ○ | `1.0.0` のような版。更新のときに上げる |
| `description` | ○ | 一覧に出る説明 |
| `author` | ○ | 作った人 |
| `minApiVersion` | ○ | 必要なホスト API のバージョン。本体のほうが古ければ読み込まない。いまは `9`（`6` の本体には `disnans.call` がなく、`5` の本体には `notify`（`postMessage` の通知）と `openSettings` がなく、`4` の本体には `postMessage` がなく、`8` の本体には `addMessageAction` / `openTimeline` がなく、`1` の本体には `addCommand` の `slash` などがなく、`2` の本体には `broadcast` / `addStatusBarItem` / `holdBackground` がなく、`3` の本体には `holdBackground` の `actions` / `update` がない。`disnans.audio` は `5` から） |
| `icon` | | プラグインのアイコン。[Lucide](https://lucide.dev/icons/) のアイコン名（`dice-5` など。英小文字・数字・ハイフン、64 文字まで） |

ダイスの manifest:

```json
{
  "id": "dice",
  "name": "ダイス",
  "version": "1.2.0",
  "description": "サイコロを振って、結果をみんなに見せる",
  "author": "sanpino",
  "minApiVersion": 2,
  "icon": "dice-5"
}
```

ダイスは `icon.svg`（立方体のサイコロ）も同梱しているので、アイコンにはそちらが使われます。manifest の `icon` は、`icon.svg` を読めなかったときの予備です。

配布できるのは `manifest.json`・`main.js`・`styles.css`（任意）・`icon.svg`（任意）の4つだけで、合計 5 MB までです。
`icon.svg` はプラグインのアイコンにする SVG です（UTF-8、64 KB まで）。Lucide にないアイコンを使いたいときに置きます。
24×24 の viewBox で、`stroke="currentColor"`（または `fill="currentColor"`）にすると本体の色に合います。
プラグインのアイコンは `icon.svg` → manifest の `icon` → 既定（`puzzle`）の順に決まり、設定の一覧・パネルの上部・カード・
「＋」メニューや補完の既定のアイコンに出ます（→ [PLUGIN_UI.md の「アイコン」](PLUGIN_UI.md#アイコン)）。
画像などは、`main.js` に data URL や SVG 文字列として埋め込んでください。

---

## main.js の書き方

- **ES モジュール**で、`Plugin` を継承したクラスを `export default` する
- ホスト API はグローバルの **`disnans`** から取る。`import` は使わない
- ビルドは要らない。素の JS のまま書ける

```js
// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

const { Plugin } = disnans;

export default class DicePlugin extends Plugin {
  onload() {
    this.addCommand({ /* ... */ });
    this.registerView('dice', (session) => new DiceView(this, session));
    // ほかに addComposerAction / addIcon / registerCardRenderer / addSettingTab / registerInterval など
  }

  onunload() {
    // add* / register* で登録したものは自動で片付く。それ以外の後始末だけ書く
  }
}
```

### 型チェック（任意）

先頭の2行で、VS Code などのエディターが補完と型チェックをしてくれます。

- `// @ts-check`: この JS ファイルを型チェックする
- `/// <reference path="…/index.d.ts" />`: SDK の型定義を読み込む。パスは `main.js` から見た場所に書き換える（リポジトリの外に置いたなら、`index.d.ts` をコピーしてきてもよい）

JSDoc で型を付けられます。名前空間 `Disnans` の型（`Disnans.Session` など）がそのまま使えます。

```js
/**
 * @typedef {object} DiceState
 * @property {number} schema
 * @property {string} spec
 * @property {number} count
 * @property {number} sides
 * @property {string} roller
 * @property {number[] | null} result
 */

/** @typedef {Disnans.Session<DiceState>} DiceSession */
```

コマンドラインで確かめるなら、`examples/dice/tsconfig.json` のような設定を置いて `tsc -p <フォルダ>` を実行します。

```sh
app/node_modules/.bin/tsc -p examples/dice
```

---

## ライフサイクル

```
読み込み ──► new MyPlugin() ──► onload()
                                 │  add* / register* で登録する
                                 ▼
                               動いている
                                 │  更新・ホットリロード・オフ・削除
                                 ▼
                              onunload() ──► 登録したものを本体が片付ける ──► 開いていた view の onClose()
```

- `onload()` で、コマンドや view などを登録します。`async` にしてもかまいません（`loadData()` を待つなど）
- 読み込み直し（更新・ホットリロード・オフ）のときは、`onunload()` を呼んでから新しいものを読み込みます
- **`add*` / `register*` で登録したものは、外すときに本体が自動で片付けます**（コマンド、view、DOM のイベント、`setInterval`、`register(cleanup)` で渡した関数）。`onunload()` には、それ以外の後始末だけを書きます
- `styles.css` は、読み込むと自動で適用し、外すと取り除きます

---

## ホスト API

`this` は `Plugin` を継承したクラスのインスタンス、`disnans` はグローバルです。

| API | 内容 |
|---|---|
| `this.app.me` / `this.app.users` / `this.app.user(id)` / `this.app.nameOf(id)` | 自分・メンバー |
| `this.app.isMobile` / `this.app.theme` | モバイルか、現在のテーマ（`'light'` / `'dark'`） |
| `this.manifest` | 自分の manifest |
| `this.addCommand(cmd)` | コマンド。コマンドパレット・ホットキー（デスクトップ）・入力欄の `/コマンド`（`slash`）から実行できる |
| `this.addSlashCommand(cmd)` | 入力欄の `/コマンド` だけ（API v1 からある書き方。新しく書くなら `addCommand` の `slash`） |
| `this.addComposerAction(action)` | 入力欄の「＋」メニュー |
| `this.registerView(type, factory)` / `this.openView(type, session)` | パネル（モバイルでは全画面）に出す画面 |
| `this.registerCardRenderer(render)` | カードの見た目 |
| `this.sessions.create(...)` / `this.sessions.get(id)` | セッション |
| `session.update(state, { card })` / `session.onChange(cb)` | 楽観ロック付きの保存、変更の購読 |
| `session.emit(name, payload)` / `session.on(name, cb)` | 保存しない一時的なイベント |
| `this.notify(userIds, text, { session })` | 通知 |
| `this.postMessage({ body, threadId?, name?, notify? })` | ボットとしてメッセージを投稿する（v5）。投稿者は自分のままで、名前は `name`（省略するとプラグインの名前）。`notify: true`（v6）なら、通常の宛先に加えて投稿した本人にも通知が届く（文言はボットの名前）。省略すると通知は送らない。例: `examples/bot` |
| `this.openSettings()` | このプラグインの設定画面を開く（v6）。設定タブに切り替える |
| `this.broadcast(name, payload)` / `this.onBroadcast(name, cb)` | セッションに紐づかない一時的なイベント（v3）。いまつながっている人に届く |
| `this.addStatusBarItem()` | 常時表示のステータス欄（画面上部の枠。通話のバーと同じ）に出す要素（v3） |
| `this.holdBackground({ microphone, actions, onAction })` | 画面を切っても動き続ける（v3。Android のフォアグラウンドサービス）。通知のボタンと `update()` は v4 |
| `this.addMessageAction(action)` | メッセージの長押しメニュー・ホバーのツールバーに項目を足す（v9。→ [メッセージの操作とタイムライン](#メッセージの操作とタイムラインv9)）。例: `examples/messages` |
| `this.openTimeline(opts)` | メッセージの集合を、本体のメッセージ表示のままパネルに出す（v9。同上） |
| `this.addSettingTab(tab)` | プラグインの設定画面（設定 → プラグインの一覧で、トグルの右の歯車から開く） |
| `this.addIcon(name, svg)` | 独自のアイコンを登録する（→ [PLUGIN_UI.md](PLUGIN_UI.md#addicon独自のアイコン)） |
| `this.loadData()` / `this.saveData(data)` | その端末にだけ保存するデータ |
| `this.register(cleanup)` / `this.registerDomEvent(...)` / `this.registerInterval(id)` | 後始末を自動で行う登録 |
| `disnans.ui.*` | 本体と同じ見た目の部品とアイコン（→ [PLUGIN_UI.md](PLUGIN_UI.md)） |
| `disnans.VersionConflictError` | `session.update` がぶつかったときのエラー |
| `disnans.audio.listOutputs()` / `setOutput(id)` / `listInputs()` / `attach(el)` | 音の入出力の選択（v5）。Android は通話中の出力先（受話口・スピーカー・イヤホン・Bluetooth）、デスクトップは `setSinkId`。使えない環境では一覧が空 |
| `disnans.call.*` | 本体の通話の状態の読み取りと、参加者どうしのデータの送受信、通話のバーのボタン（v8。→ [通話の拡張 API](#通話の拡張-apidisnanscallv8)） |
| `disnans.ui.onBack(handler)` / `ui.setImmersive(on)` | 戻る操作（Android の戻るジェスチャー・PC の Alt+←）で閉じる層を足す／Android で全画面（システムバーを隠す没入モード）にする（v9。→ [画面共有のためのネイティブ API](#画面共有のためのネイティブ-apiv9)） |
| `disnans.screenCapture.*` / `disnans.pip.*` | Android の画面のキャプチャ（MediaProjection）と、ピクチャーインピクチャー（v9。同上） |
| `disnans.apiVersion` | ホスト API のバージョン（いまは 9） |

### コマンド（パレット・ホットキー・スラッシュコマンド）

`addCommand` で足したコマンドは、次の3つから実行できます。

- **コマンドパレット**（デスクトップ。既定は Ctrl+P、macOS では Cmd+P）: 名前で絞り込んで Enter
- **ホットキー**（デスクトップ。Android では効きません）: `hotkey` は既定のキーで、利用者は **設定 → ホットキー** で変えたり外したりできます
- **スラッシュコマンド**: `slash` を付けると、入力欄の `/名前` にもなります（補完に出ます）

```js
this.addCommand({
  id: 'roll',                    // プラグインの中で一意。利用者のホットキーの設定は `dice:roll` で保存される
  name: 'サイコロを用意する',      // パレット・設定の一覧に出る名前
  icon: 'dice-cube',             // アイコン（addIcon で登録したもの。省略するとプラグインのアイコン）
  hotkey: 'Mod+Shift+D',         // 既定のホットキー。Mod は Ctrl（macOS では Cmd）
  slash: 'dice',                 // `/dice`。英小文字・数字・ハイフン。省略するとスラッシュコマンドにしない
  description: 'サイコロを振る',   // 補完に出る説明（省略すると name）
  args: '[個数]d[面数]',           // 引数の書き方のヒント
  // 引数の候補。input はコマンド名のあとに打った文字列
  suggestArgs: (input) => {
    const q = input.trim().toLowerCase();
    return PRESETS.filter((p) => p.value.startsWith(q)); // [{ value: '2d6', description: 'サイコロ2個' }, ...]
  },
  // ctx.args: `/dice 2d6` なら '2d6'（前後の空白は除く）。ホットキー・パレットからは ''
  // ctx.threadId: スラッシュコマンドは入力したスレッド、ホットキー・パレットは開いているスレッド（なければ null）
  // ctx.via: 'slash' / 'hotkey' / 'palette'
  run: (ctx) => this.prepare(ctx.args, ctx.threadId),
});
```

ダイスの `prepare` は、`args` が空なら設定の「既定のサイコロ」を使います。
ホットキーもスラッシュコマンドもないコマンド（ダイスの「20面のサイコロを用意する」）は、パレットから実行します（利用者は設定でホットキーを付けられます）。

- `/dice 2d6` のように送信すると、メッセージとしては送らずに `run` を呼びます
- 入力の誤りは `disnans.ui.toast('…', 'error')` で知らせます。`run` が例外を投げた（reject した）ときも、本体がエラーのトーストを出します
- 候補（`Suggestion`）は `{ value, label?, description? }`。`value` が入力欄に入ります
- `hotkey` が読めない・`slash` の名前が正しくないときは、その部分を外して登録し、設定のプラグイン一覧にエラーを出します
- ホットキーは、入力欄で文字を打っている間は Ctrl・Cmd・Alt を含むもの（と F1〜F12）だけが効きます
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
  run: ({ args, threadId }) => disnans.ui.toast(`こんにちは ${args}`),
});
```

### ＋メニュー

```js
this.addComposerAction({
  id: 'roll-2d6',
  label: 'サイコロ（2d6）',
  icon: 'dices', // アイコンの名前（Lucide の名前。省略するとプラグインのアイコン）
  run: ({ threadId }) => this.prepare('2d6', threadId),
});
```

`icon` は**アイコンの名前**です（Lucide の名前・`disnans-logo`・`addIcon` で登録した名前）。
独自の SVG を使うときは、先に `this.addIcon('dice-cube', '<path .../>')` で登録してから名前で指定します（→ [PLUGIN_UI.md](PLUGIN_UI.md#アイコン)）。
ダイスは `onload` の最初に、立方体のサイコロを `dice-cube` として登録し、`/dice` のコマンド・パネルの上部・タブ・カードで使っています。

```js
// <svg> の中身だけを渡すと、既定は fill="none" stroke="currentColor" stroke-width="2"（Lucide と同じ）
this.addIcon('dice-cube', '<path d="M12 2 21 7v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>…');
```

### メッセージの操作とタイムライン（v9）

メッセージを長押ししたときのメニュー（モバイル）と、デスクトップでホバーしたときのツールバーに、項目を足せます。本体の項目（返信・スレッドを立てる・コピー・編集・削除、ツールバーのリアクション）も同じ仕組みで並んでいて、`order`（小さいほど前）で並びが決まります。

```js
this.addMessageAction({
  id: 'later',
  label: 'あとで読む',
  icon: 'bookmark',          // アイコンの名前。省略するとプラグインのアイコン
  placement: 'both',         // 'menu'（長押し）| 'toolbar'（ホバー）| 'both'。省略は both
  order: 1000,               // 省略は 1000。本体は 返信 200・スレッド 300・コピー 400・編集 500・削除 9000（リアクションはツールバー先頭の 100）
  danger: false,             // true で注意の色
  when: (msg, ctx) => !msg.card,           // 省略すると常に出す。送信中の仮表示には出ない
  run: (msg, ctx) => { /* ctx = { threadId, inThread } */ },
});
```

`msg` は本体のメッセージ（`id` `author_id` `thread_id` `reply_to` `body` `reactions` `created_at` `edited_at` `card` `bot` など。型は `Disnans.Message`）。`when` が例外を投げた項目は出さず、`run` の例外はトーストで知らせます。

`openTimeline` は、メッセージの集合を**本体のメッセージ表示**（リアクション・返信の引用・長押しメニューもそのまま）で、パネル（デスクトップは右、モバイルは全画面）に並べます。スレッドのパネルや返信のツリーと同じ枠です。

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

### view

パネル（モバイルでは全画面）に独自の画面を出します。view は `onOpen(containerEl)` で `containerEl` に描き、`onClose()` で購読を外します。

```js
// type をプラグイン ID と同じ名前にすると、カードをタップしたときにこの view で開く
this.registerView('dice', (session) => new DiceView(this, session));

// 自分で開くとき
this.openView('dice', session);
```

```js
/** @implements {Disnans.View} */
class DiceView {
  /** @param {DicePlugin} plugin @param {DiceSession} session */
  constructor(plugin, session) {
    this.plugin = plugin;
    this.session = session;
    this.title = 'ダイス';    // パネルの上部の題名（省略するとプラグイン名。'' なら出さない）
    this.icon = 'dice-cube'; // パネルの上部のアイコン（省略するとプラグインのアイコン。'' なら出さない）
    this.tab = 'result';
  }

  /** @param {HTMLElement} containerEl @param {Disnans.ViewPanel} panel */
  onOpen(containerEl, panel) {
    this.panel = panel;
    this.cleanups = [
      this.session.onChange(() => this.render()), // 誰かが更新したら描き直す
      this.session.on('shake', (_payload, from) => { /* 揺らす（→ 一時的なイベント） */ }),
    ];
    // 中身とタブのバー。バーは一度だけ作り、中身だけを描き直す
    this.bodyEl = document.createElement('div');
    const nav = disnans.ui.navbar({
      label: 'ダイスのタブ',
      selected: this.tab,
      items: [
        { id: 'result', label: '結果', icon: 'dice-cube' },
        { id: 'help', label: '使い方', icon: 'book-open' },
      ],
      onSelect: (id) => {
        this.tab = id;
        this.render();
      },
    });
    containerEl.append(this.bodyEl, nav);
    this.render();
  }

  onClose() {
    for (const off of this.cleanups) off(); // 購読は自分で外す
  }

  render() {
    const state = this.session.state;
    // パネルの上部: 題名にサイコロの表記、振ったあとはアイコンを出目に合わせる（null で既定に戻す）
    this.panel.setTitle(`ダイス（${state.spec}）`);
    this.panel.setIcon(state.result ? 'dices' : null);
    this.bodyEl.replaceChildren(this.tab === 'help' ? this.renderHelp() : this.renderResult());
  }
}
```

- 描くのは `containerEl` の中だけにします
- 題名・アイコンを途中で変えるときは、`onOpen` の2つ目の引数（`panel`）の `setTitle(title)` / `setIcon(icon)` を使います（`null` で既定に戻す）
- view の中にタブを作るなら `disnans.ui.navbar`、選択肢なら `disnans.ui.segmented` が使えます（→ [PLUGIN_UI.md](PLUGIN_UI.md)）
- 毎回まるごと描き直す（`replaceChildren`）のが一番かんたんです。state は小さいので十分速く動きます

### カード

セッションを作ると、そのセッションへのリンクとして**カード**（`{ title, text }`）がチャットに流れます。
カードをタップすると、プラグイン ID と同じ type の view でセッションを開きます。

- `session.update(state, { card })` でカードを書き換えられます（新しいメッセージは流れません）
- プラグインがない・オフの人には、本体の標準の見た目で最後の `title` / `text` が出ます。**`text` だけで内容がわかるように**書いてください
- 見た目を変えたいときは `registerCardRenderer` を使います（省略すると標準のカード）

ダイスは、題名の左に独自のアイコンを出し、振ったあとのカード（「🎲 …」）を等幅の大きめの文字にしています。

```js
this.registerCardRenderer((el, card) => {
  // card は { sessionId, title, text }。el は本体のカードの枠の中
  const head = h('div', 'dice-card-head');
  head.append(disnans.ui.icon('dice-cube', { size: 14 }), h('span', 'dice-card-title', card.title));
  const done = card.text.startsWith('🎲');
  el.replaceChildren(head, h('div', done ? 'dice-card-text dice-card-done' : 'dice-card-text', card.text));
});
```

- 渡されるのは `title` と `text` だけです。state を見て描きたいときも、カードの文言に必要なことを入れておきます

### セッションと楽観ロック

ゲームの1局のような「1回分の利用」をセッションと呼びます。サーバーに保存され、全員に同期します。

```js
const session = await this.sessions.create({
  state: { schema: 1, spec: '2d6', count: 2, sides: 6, roller: this.app.me.id, result: null },
  card: { title: 'ダイス', text: 'A がサイコロ（2d6）を用意しました' },
  threadId, // スレッドに流すなら ID、メインチャットなら null
});
this.openView('dice', session);
```

- `session.state` は常に最新です（他の人の更新も反映される）。`session.version` は更新のたびに +1 されます
- 同期は「**状態をまるごと書き換える**」方式です。`update` には新しい state を丸ごと渡します（1 MB まで）
- `this.sessions.get(id)` でセッションを読めます。同じ ID なら同じオブジェクトが返ります

`update` は**楽観ロック**付きです。読み込んだときから他の人が更新していると `disnans.VersionConflictError` で失敗します。
そのときは `session.state` がすでに最新になっているので、最新の state で考え直してやり直します。ダイスの [振る] は次のとおりです。

```js
async saveResult() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = this.session.state;
    if (state.result) return; // もう振られている → そのまま表示
    const result = rollDice(state.count, state.sides); // crypto.getRandomValues で振る
    try {
      await this.session.update(
        { ...state, result },
        { card: { title: 'ダイス', text: `🎲 A: ${state.spec} → 3 + 5 = 8` } },
      );
      return; // 成功すると onChange が呼ばれ、view が描き直される
    } catch (e) {
      if (!(e instanceof disnans.VersionConflictError)) throw e;
      // ぶつかった。session.state は最新になっているので、ループの頭でもう一度考える
    }
  }
  disnans.ui.toast('ほかの更新とぶつかったため、振れませんでした', 'error');
}
```

ダイスの [振る] は、設定の「振る前に確認する」がオンなら、先に確認のダイアログを出します。

```js
async roll() {
  if (this.plugin.settings.confirmBeforeRoll) {
    const ok = await disnans.ui.confirm({ title: '2d6 を振りますか？', body: '振れるのは1回だけです。', okLabel: '振る' });
    if (!ok) return;
  }
  this.session.emit('shake');      // ほかの人の画面でも揺らす（→ 一時的なイベント）
  this.startShaking(/* ... */);     // 自分の画面は自分で揺らす
  await sleep(700);
  await this.saveResult();
}
```

ゲームでは「自分の番か」「その手はまだ有効か」を、やり直しのたびに最新の state で確かめてください。
友達同士なので、チート対策は考えません（state は誰でも書き換えられます）。

### 一時的なイベント

保存しないイベント（「考え中…」、カーソルの位置など）は、`emit` / `on` で中継だけします。途中で開いた人には届きません。

ダイスは、振る人が [振る] を押したときに `shake` を送り、見ている人の画面でもサイコロを揺らします（「A が振っています…」）。
結果は `update` で保存するので、揺れは結果が届いた（`onChange`）ところで止めます。

```js
// 送る（自分には届かない。自分の画面は自分で揺らす）
this.session.emit('shake');

// 受け取る。from は送った人。payload は emit の2つ目の引数（省くと null）
const off = this.session.on('shake', (_payload, from) => {
  const state = this.session.state;
  if (state.result || from.id !== state.roller) return; // 振る人以外・振ったあとのものは無視する
  this.startShaking(from.id, 5000); // 結果が来ないまま 5 秒たったら止める
});
// view の onClose で off() する
```

演出のコマ送り（揺れている間、目の数字を入れ替える）には、`onload` で登録したタイマーを1つだけ使っています。
`registerInterval` / `registerDomEvent` で登録すると、プラグインを外すときに本体が止めてくれます（→ [後始末は register* で](#後始末は-register-で)）。

```js
this.registerInterval(window.setInterval(() => this.tick(), 80)); // 開いている view の tick() を呼ぶ
// アプリが裏に回るとタイマーが間引かれるので、そこで演出を終える
this.registerDomEvent(document, 'visibilitychange', () => {
  if (document.hidden) for (const view of this.openViews) view.stopShaking();
});
```

### プラグイン全体の一時的なイベント（broadcast、v3）

`session.emit` は、先にセッション（とチャットのカード）を作らないと使えません。ちょっとした合図のように、**カードを作らず、いまつながっている人に届けばよいもの**には `broadcast` を使います。

```js
// 送る。自分には届かない（自分の別の端末には届く）。payload は JSON にできる値で、64 KB まで
this.broadcast('presence', { peer: 'abc', muted: false });

// 受け取る。from は送った人。外すときに自動で外れる（戻り値の関数でも外せる）
const off = this.onBroadcast('presence', (payload, from) => { /* ... */ });
```

- 保存しません。オンラインの人にだけ届き、あとから来た人には届きません（来た人に今の状態を知らせたいときは、定期的に送る・来た人に気づいたら送る、などをプラグインでします）
- 宛先は選べず、**プラグイン ID が同じなら全員に**届きます（そのプラグインを入れていない人の端末では、何も起きません）。1人宛てにしたいときは payload に宛先を入れ、受け取る側で見分けます
- 名前は 64 文字まで。ネットワークが切れている間のイベントは失われます

### ステータス欄（addStatusBarItem、v3）

画面の最上部の共通の枠（トップバーのスロット。通話のバーも同じ枠に出ます）に、プラグイン共通の**常時表示の帯**として要素を足します。画面（チャット・設定・スレッド）を切り替えても出ています。

```js
const el = this.addStatusBarItem(); // 空の <div>。外すときに自動で消える
el.replaceChildren(ui.icon('headphones'), 'ステータス');
```

- 中身は自由に描きます。**何も入れていない（`:empty`）間は項目も帯も隠れる**ので、出したいときだけ描いてください
- 帯は小さいので、アイコンと短い文字、小さなボタンだけにします。大きな画面は view を使います
- 色や大きさは CSS 変数と共通クラスを使います（帯の背景は `--surface`）
- 通話のバーにボタンを足したいときは、これではなく `disnans.call.addButton`（下）を使います

### 画面を切っても動き続ける（holdBackground、v3）

```js
// getUserMedia でマイクの許可を得たあとに呼ぶ
const release = await this.holdBackground({ microphone: true, title: 'ボイスチャット', text: '通話中です' });
// やめるとき
release();
```

- **Android**: フォアグラウンドサービス（`microphone` 型）を動かし、通知欄に「通話中」を出します。画面を消す・別のアプリに切り替えるときに、WebView を止めない（タイマーが続く）ようにもします。`microphone: true` は、**マイクの許可を得たあと、アプリが前面にあるときに**呼びます（Android 14 以降の決まり）
- **デスクトップ・ブラウザー**: ウィンドウが裏に回っても動くので、何もしません
- 複数のプラグインが頼んでもよく、最後の1つが解除されたら止まります。プラグインを外すと自動で解除されます

#### 通知のボタンと文言の更新（v4）

```js
const bg = await this.holdBackground({
  microphone: true,
  title: 'ボイスチャット',
  text: '通話中 ・ 3人',
  actions: [
    { id: 'mute', title: 'ミュート' },
    { id: 'hangup', title: '切断', dismiss: true },
  ],
  onAction: (id) => {
    if (id === 'mute') this.toggleMute();
    else if (id === 'hangup') this.leave();
  },
});
// 状態が変わったら、渡した項目だけ差し替わる（ボタンも差し替えられる）
bg.update({ text: 'ミュート中 ・ 3人', actions: [{ id: 'mute', title: 'ミュート解除' }, { id: 'hangup', title: '切断', dismiss: true }] });
bg(); // 解除（関数として呼ぶ）
```

- ボタンは最大3つ。Android だけで、ほかの環境では何も出ません（`onAction` も呼ばれません）
- アプリが裏にいても、通話中は WebView を止めないので `onAction` が呼ばれます。万一 JS に届けられなかったときは、`dismiss: true` のボタンだけ、本体が通知とサービスをその場で止めます（「切断」のように必ず効かせたいボタン用）。それ以外のボタンは、次に JS が動いたときに届きます
- 複数のプラグインが同時に頼んだときは、通知に出ている（最後に頼んだ）プラグインの `onAction` にだけ届きます
- `update()` は解除したあとは何もしません。古い本体（v3 以前）では `update` がないので、`minApiVersion` を `4` にしてください

### 通知

```js
await this.notify([nextPlayerId], 'あなたの番です', { session: this.session });
```

`session` を渡すと、通知から開いたときにそのカードの場所を開きます。
ダイスのように、カードの書き換えで足りるときは通知は要りません（通知はうるさくなりがちなので、必要なときだけ）。

### 設定タブ

ダイスの設定タブ（**設定 → プラグイン → ダイスの歯車**で開く画面）は、選択肢（`ui.segmented`）・トグル（`ui.toggle`）・区切り線・
確認してから実行する危ないボタン（`ui.button` の `danger` と `ui.confirm`）を、設定の行（`ui.setting`）に並べたものです。

```js
async onload() {
  this.settings = await this.loadSettings(); // loadData() で読み、足りない値は初期値で埋める
  this.addSettingTab({ display: (containerEl) => this.displaySettings(containerEl) });
}

/** @param {HTMLElement} containerEl */
displaySettings(containerEl) {
  const { ui } = disnans;
  ui.setting(containerEl, {
    name: '既定のサイコロ',
    description: '/dice だけで送ったときと、ホットキーで用意するサイコロ',
    icon: 'dice-cube',
    control: ui.segmented({
      label: '既定のサイコロ',
      value: this.settings.defaultSpec,
      options: ['1d6', '2d6', '3d6', '1d20', '1d100'].map((spec) => ({ value: spec, label: spec })),
      onChange: (value) => void this.setSetting('defaultSpec', value), // this.settings を変えて saveData する
    }),
  });
  ui.setting(containerEl, {
    name: '振る前に確認する',
    icon: 'circle-help',
    control: ui.toggle({
      label: '振る前に確認する', // 読み上げ用。見える名前は ui.setting の name
      value: this.settings.confirmBeforeRoll,
      onChange: (value) => void this.setSetting('confirmBeforeRoll', value),
    }),
  });
  // 「出目の演出」のトグルも同じ
  containerEl.append(ui.divider());
  ui.setting(containerEl, {
    name: '設定を初期値に戻す',
    icon: 'rotate-ccw',
    control: ui.button({ text: '初期値に戻す', variant: 'danger', onClick: () => void this.resetSettings(containerEl) }),
  });
}

/** @param {HTMLElement} containerEl */
async resetSettings(containerEl) {
  const ok = await disnans.ui.confirm({ title: '設定を初期値に戻しますか？', okLabel: '初期値に戻す', danger: true });
  if (!ok) return;
  this.settings = { ...DEFAULT_SETTINGS };
  await this.saveData(this.settings);
  // 部品は自分の値を覚えているので、描き直して見た目を合わせる
  containerEl.replaceChildren();
  this.displaySettings(containerEl);
}
```

- `display` は表示のたびに空の `containerEl` で呼ばれます
- 部品の `onChange` で、すぐに `saveData` します（「保存」ボタンは要りません）

### loadData / saveData

その端末にだけ保存するデータ（設定など）です。ほかのメンバーとは共有されません。共有したいものはセッションに入れます。

```js
/** @type {{ history: string[] } | null} */
const data = await this.loadData(); // なければ null
await this.saveData({ history: ['2d6', '1d20'] }); // JSON にできる値
```

保存したデータは、古い版のプラグインが書いたものかもしれません。ダイスの `loadSettings` のように、型を確かめて使える値だけを拾うと安全です。

```js
async loadSettings() {
  const saved = await this.loadData();
  const s = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    if (typeof saved.confirmBeforeRoll === 'boolean') s.confirmBeforeRoll = saved.confirmBeforeRoll;
    // ...
  }
  return s;
}
```

### disnans.ui

本体と同じ見た目の部品（ボタン・トグル・入力欄・選択肢・タブのバー・区切り線・設定の行・アイコン・トースト・確認ダイアログ）です。
すべての関数・オプション・例と CSS クラスは [PLUGIN_UI.md](PLUGIN_UI.md) にまとめてあります。

```js
const { ui } = disnans;
ui.button({ text: '振る', icon: 'dices', variant: 'primary', onClick: () => this.roll() });
ui.toast('設定を初期値に戻しました');
```

### 通話の拡張 API（disnans.call、v8）

通話（ボイスチャット）は**アプリ本体の機能**で、プラグインではありません（参加・ミュート・出力先などは本体の画面と設定にあります）。
画面共有のような機能を足せるように、本体の通話に次の API を用意しています。型は [`index.d.ts`](../packages/plugin-sdk/index.d.ts) の `Disnans.Call`。
音声はすべてサーバー経由で、WebRTC は使いません。v7 にあった `addTrack` `removeTrack` `onTrack` `onTrackEnd` `remoteTracks` `canVideo`（と参加者の `canVideo`）は v8 で外れました。

```js
const { call } = disnans;

call.joined;        // 参加しているか
call.participants;  // [{ peer, user, self, muted, deafened, connected, speaking, device }]
await call.join();  // 参加（失敗はトーストで知らされる）
call.leave();
```

- **状態の変化**: `call.onChange(cb)`（参加・退出・参加者の出入り・ミュート・しゃべり始めなど。しゃべっている人の変化も含むので、重い処理はしない）
- **データを送る**: `call.emit(name, payload)` で、通話の参加者全員（自分以外）にサーバー経由で送ります（保存されません）。`payload` は JSON にして 64 KB まで、`name` は 1〜64 文字（`audio` は本体が使うので使えません）。通話に参加していないときは例外です。送りすぎるとサーバーが黙って捨てます（目安は 1 秒に 3 MB ほどまで。音声の分を含む。受け手の送信待ちが詰まっているときも、その受け手には送られません）。画像を送るなら、縮小して JPEG などにしてフレームレートを抑えてください
- **データを受け取る**: `call.onEvent(name, ({ peer, user, payload }) => ...)`。自分が送ったものは届きません。戻り値の関数で外します
- **バーのボタン**: `call.addButton({ icon, label, onClick, active?, disabled? })` で、通話のバー（参加中だけ表示）にボタンを足します。戻り値の `update(patch)` / `remove()` で変えたり外したりします
- コールバックの登録の戻り値の関数は、プラグインが外されるときに自動では外れないので、`this.register(...)` に渡して片付けます

```js
// 画面共有のひな形（縮小したフレームを送る）
const btn = call.addButton({ icon: 'monitor-up', label: '画面を共有', onClick: () => share() });
this.register(() => btn.remove());
async function share() {
  if (!call.joined) return disnans.ui.toast('通話に参加していません', 'error');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  // …1 秒に数回、canvas に縮小して描き、toDataURL('image/jpeg', 0.5) を call.emit('screen', { img }) で送る
}
this.register(call.onEvent('screen', ({ user, payload }) => { /* <img> に payload.img を出す */ }));
```

実例は **画面共有**（[`examples/screenshare/`](../examples/screenshare/)、v9）です。通話のバーのボタンから画面を取り、縮小した画像（JPEG / WebP / PNG）にして `call.emit` で送ります。

- 取る側: `getDisplayMedia` があればそれ（デスクトップ。Linux の WebKitGTK でも、`xdg-desktop-portal` と PipeWire があれば動きます）、無ければ `disnans.screenCapture`（Android）を使います。どちらも無ければ共有ボタンを出さず、見るだけです
- 送る側: 1 回の payload の上限（64 KB）を超えるフレームは分割して送り（`{ f: フレーム番号, i, n, d: base64 の一部 }`）、受け手が組み立てます（欠けたフレームは捨てる）。画像の形式は先頭のバイトから見分けるので、送り手は JPEG・WebP・PNG のどれでも送れます。サーバーの流量制限（容量 4000・毎秒 3000 回復・1 回の重さ = 1 + payload の KB）に収まるよう、映像の予算を毎秒 2400 KB（重さ）にして、直前のフレームの大きさから次の間隔を決め、大きすぎれば画質→解像度の順に下げ、画面が変わらなければ送りません
- 設定: FPS（5 / 20）、画質（480p・品質 50% / 720p・品質 60% / 1080p・品質 80%）、色数（フルカラー / 256 色 / グレースケール）。色数を減らす設定では、減色した画像を PNG・WebP・JPEG のうち小さいもので送ります（JPEG は減色の効果が薄いため）。設定画面に、今の設定で符号化した画像と 1 フレームのおおよそのサイズ・帯域のプレビューがあります（サンプルの画面か、自分の画面を一度だけ取り込んだもの）
- 見る側: プラグインが `document.body` に全画面のオーバーレイを足して表示します（ダイアログ・トーストより下、Esc でも閉じる）。共有者が複数ならタブで切り替えます。ピンチ・ホイールで拡大縮小、ドラッグでパン、ダブルタップ（ダブルクリック）で拡大／元に戻す。全画面は `ui.setImmersive`（Android）か Fullscreen API、戻るジェスチャーは `ui.onBack` で全画面の解除→閲覧を閉じる、の順。PiP は Android なら `disnans.pip`、デスクトップなら受け取った画像を `<canvas>` に描いて `captureStream()` した `<video>` の `requestPictureInPicture()`

本体の通話のしくみ（参加者の管理と kick はサーバー、音声とデータもサーバー経由）は [`SPEC.md`](../SPEC.md) の 9.11、サーバーの経路は [`API.md`](API.md) の WebSocket を参照してください。
マイクを使うには**アプリ版（Tauri）が必要**です（WebView の `getUserMedia` は安全なコンテキストでしか動かないため、`http://` で開いたブラウザー版では使えません）。

---

### 画面共有のためのネイティブ API（v9）

画面共有の実例が使う、本体の API です。Android の WebView には `getDisplayMedia` も Fullscreen API も無いため、ネイティブの機能を本体が包んで渡します。型は [`index.d.ts`](../packages/plugin-sdk/index.d.ts)。

```js
const { ui, screenCapture, pip } = disnans;

// 戻る操作で閉じる層。戻る操作のたびに、新しいものから 1 つずつ handler が呼ばれる（本体のパネルなどより先）
const off = ui.onBack(() => close());
this.register(off);

// 全画面。Android はシステムバーを隠す没入モード（true）。ほかの環境では何もせず false なので Fullscreen API を使う
if (!(await ui.setImmersive(true))) await el.requestFullscreen();

// Android: MediaProjection で画面を撮る（OS の確認のダイアログと、通知欄の常駐が出る）
if (screenCapture.supported) {
  await screenCapture.start(
    { maxEdge: 1280, quality: 0.6, fps: 5, color: 'full', onEnd: () => onStopped() },
    ({ data, mime, width, height }) => send(data), // data は base64
  );
  await screenCapture.update({ quality: 0.5 }); // 撮りながら変える
  await screenCapture.stop();
}

// Android: Activity の PiP（小窓）。小窓の間はアプリの画面がそのまま小さく出るので、onChange で表示を切り替える
if (pip.supported) {
  this.register(pip.onChange((active) => setCompact(active)));
  await pip.enter({ aspect: { width: 16, height: 9 } });
}
```

- `screenCapture.start` は、断られたら例外です。フレームは、画面が変わったときと、変わらなくても `keepaliveMs`（既定 5 秒）ごとに 1 枚届きます。`color` が `c256` / `gray` のときは、減色したうえで可逆の WebP（Android 11 以降。それ以前は PNG）と lossy の WebP を比べて小さいほうを渡します
- `onEnd` は、通知欄の「停止」やシステム側の操作で止められたときに呼ばれます（`stop()` では呼ばれません）
- デスクトップ・ブラウザーでは `screenCapture.supported` と `pip.supported` は `false` です。PiP は `<video>` の `requestPictureInPicture()` を使ってください
- 通話中にアプリを裏に回しても共有が続くのは、通話のフォアグラウンドサービス（マイク）と、画面のキャプチャのフォアグラウンドサービス（`mediaProjection`）が動いているためです

## 見た目（CSS）

`styles.css` を置くと、読み込んだときに自動で適用し、オフにすると取り除きます。

### 本体の CSS 変数

本体の色や大きさは CSS 変数になっています。これを使えば、**ライト・ダークのどちらでも**本体に合う見た目になります（テーマが変わると変数の値が変わる）。

| 変数 | 用途 |
|---|---|
| `--bg` | いちばん下の背景 |
| `--surface` / `--surface-2` | 一段・二段浮いた面（カード、ボタン） |
| `--border` | 線 |
| `--text` / `--text-muted` | 文字 / 控えめな文字 |
| `--accent` / `--accent-soft` / `--on-accent` | 強調の色 / その薄い背景 / 強調の上の文字 |
| `--danger` / `--danger-soft` | 危険・エラー |
| `--success` / `--warning` / `--mention` / `--mention-soft` | 成功 / 注意 / メンション |
| `--hover` | ホバーの背景 |
| `--shadow` | 浮いたものの影 |
| `--radius` / `--radius-sm` | 角の丸み（10px / 6px） |
| `--font` / `--mono` | 本文 / 等幅のフォント |

### 共通クラス

`.btn`・`.input`・`.segmented`・`.nav-bar`・`.divider`・`.setting-row` などの本体のクラスは、プラグインからも使えます。
一覧は [PLUGIN_UI.md の「CSS クラス」](PLUGIN_UI.md#css-クラス) を参照してください。

### 書き方の決まり

- 自分のクラスには**プラグイン ID の接頭辞**を付けます（ダイスなら `.dice-view`, `.dice-face`）。本体や他のプラグインとぶつからないようにするためです
- `body` や `.btn` など、本体のセレクターを直接書き換えないでください。全員の本体の見た目が変わります
- 色は直接書かず、CSS 変数を使います

ダイスの `styles.css`（抜粋）。揺れる演出は `@keyframes` で書き、動きを減らす設定（`prefers-reduced-motion`）の人には止めています。

```css
.dice-face {
  min-width: 72px;
  height: 72px;
  border: 2px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow);
  font-size: 36px;
  font-weight: 700;
}
.dice-face-max {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.dice-face-shaking {
  border-color: var(--accent);
  animation: dice-shake 0.24s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dice-face-shaking {
    animation: none;
  }
}
/* view の中のタブのバー（本体の .nav-bar）を、自分のクラスの下でだけ調整する */
.dice-view .nav-bar {
  padding-bottom: env(safe-area-inset-bottom);
}
```

---

## TypeScript で書く

TypeScript で書いて、ビルドで `main.js`（**ES モジュール1ファイル**）を出します。esbuild か Vite が手軽です。

- `disnans` はグローバルなので **`import` は要りません**。型定義を読み込ませるだけです
- 型定義は [`packages/plugin-sdk`](../packages/plugin-sdk/) にあります。設定とビルドの例は [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md) を見てください

```ts
type DiceState = { schema: 1; spec: string; count: number; sides: number; roller: string; result: number[] | null };

export default class DicePlugin extends disnans.Plugin {
  onload() {
    this.registerView<DiceState>('dice', (session) => new DiceView(this, session));
  }
}
```

```sh
# 開発用フォルダの中で、保存のたびにビルドする（アプリがホットリロードする）
npx esbuild src/main.ts --bundle --format=esm --target=es2022 --outfile=main.js --watch
```

esbuild は型をチェックしないので、`tsc --noEmit` も合わせて使ってください。
配布されるのは `manifest.json`・`main.js`・`styles.css`・`icon.svg` だけなので、`src/` や `node_modules/` が同じフォルダにあってもかまいません。

---

## 配布・更新・削除と、端末ごとのオンオフ

すべて **設定 → プラグイン** の一覧で行います。

| 操作 | どうなるか |
|---|---|
| **[配布] → みんなに配布** | サーバーに上がり、つながっている全員のクライアントで動き始める（チャットにお知らせは流れない） |
| **[配布] → 自分だけに配布** | サーバーに上がり、**自分のすべての端末**（Android を含む）でだけ動く。ほかの人の一覧には出ない。一覧に「自分だけ」と出る |
| **更新**（同じ `id` でもう一度 [配布]） | 上書きになる。サーバーが配信するのは常に1つの版。全員（自分だけなら自分の端末）のクライアントで読み込み直す。範囲も選び直せる |
| **削除** | 全員（自分だけなら自分の端末）のクライアントから外れる。セッションとカードは残る（同じ `id` で配布し直せば、また開ける） |
| **オン / オフ**（トグル） | **自分の端末でだけ**切り替える（その端末に保存）。配布されたプラグインは既定でオン |

- みんなに配布したものの更新・削除は誰でもできます。最後に配布・更新した人は一覧の情報（`updated_by`）に残ります
- 自分だけのものは、配布した人（`owner`）だけが更新・削除できます
- `id` はプラグインとテーマ、みんなのものと自分だけのものを通して一意です。ほかの人が自分だけに配布しているものと同じ `id` は使えません（`409 plugin_id_taken`。`id` を変えてください）
- 自分だけのプラグインを、あとから「みんなに配布」し直すこともできます。逆に、みんなのものを「自分だけに配布」し直すと、ほかの人の端末からは外れます
- 自分だけのプラグインでもセッションとカードは作れます。ただし、カードはチャットに流れて全員に見える一方、ほかの人の端末にはそのプラグインがないので、標準のカード（最後の内容を表示するだけで、タップしても開かない）になります
- 開発用フォルダに、配布済みと同じ `id` のプラグインがあれば、自分の端末では開発中のほうが動きます。配布した版を直すときは、そのまま開発用フォルダで直して [配布] すれば更新になります
- 壊れたプラグインが配られても、各自がトグルでオフにできます
- テーマ（`theme.css` だけのパッケージ）も同じ方法で配れます。作り方は [THEMES.md](THEMES.md) を見てください

---

## 注意点

### sandbox はありません

プラグインは本体と同じ WebView の中で、制限なく動きます。友達同士の信頼が前提です。そのぶん、次のことを守ってください。

- **本体の DOM を壊さない**: 触ってよいのは、`onOpen` や `display` などで渡された要素の中だけです。本体の要素を書き換えたり、消したりしないでください
- **グローバルを汚さない**: `window` に変数を足したり、組み込みのオブジェクトを書き換えたりしないでください。ホットリロードのたびに積み重なります
- 例外は握りつぶさず、利用者にはトーストで、詳細は `console.error` で出します

### 後始末は register* で

イベントやタイマーを自分で登録すると、読み込み直しのたびに増えていきます。本体が自動で片付けられるように、`register*` を使ってください。

```js
// ✗ 外し忘れる
window.addEventListener('keydown', onKey);
setInterval(tick, 1000);

// ○ 外すときに本体が片付ける
this.registerDomEvent(window, 'keydown', onKey);
this.registerInterval(window.setInterval(tick, 1000));
this.register(() => someLibrary.destroy());
```

view の中の購読（`session.onChange` / `session.on` の戻り値）は、view の `onClose()` で外します。

### state にスキーマのバージョンを入れる

セッションは、プラグインを更新したあとも残ります。古い版で作ったセッションを新しい版で開くことがあるので、state にはスキーマのバージョンを入れておき、読むときに確かめてください。

```js
const state = { schema: 1, /* ... */ };

// 読むとき
if (state.schema !== 1) {
  // 古ければ変換する。新しすぎれば「新しい版で作られたため表示できません」と出す
}
```

### そのほか

- state は JSON にできる値だけにします（1 MB まで）。関数や `Date`、`Map` は入れられません
- 乱数が結果を左右するときは `crypto.getRandomValues` を使います（ダイスの `rollDice` を参照）
- カードの `text` は、プラグインを入れていない人にもそのまま見えます。中身がわかる文にしてください
- `minApiVersion` より古い本体では読み込まれません。新しい API を使い始めたら上げてください
