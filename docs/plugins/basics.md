# プラグインの基本（manifest・main.js・ライフサイクル・ホスト API）

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

## manifest.json

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | ○ | 英小文字・数字・ハイフン（2〜32文字）。サーバー内で一意。同じ `id` を配布すると上書き（更新）になる |
| `name` | ○ | 表示名（「ダイス」） |
| `version` | ○ | `1.0.0` のような版。更新のときに上げる |
| `description` | ○ | 一覧に出る説明 |
| `author` | ○ | 作った人 |
| `minApiVersion` | ○ | 必要なホスト API のバージョン。本体のほうが古ければ読み込まない。いまの版は `15`（`14` 以下の本体には `this.files`（共有フォルダ）がない。共有フォルダを使うなら `15`。`11` 以下の本体では `call.addButton` の `location: 'view'` が使えない。`10` の本体には `screenCapture.snapshot` がなく、`9` の本体には `call.addPanel` / `call.bufferedAmount` がなく、`6` の本体には `disnans.call` がなく、`5` の本体には `notify`（`postMessage` の通知）と `openSettings` がなく、`4` の本体には `postMessage` がなく、`8` の本体には `addMessageAction` / `openTimeline` がなく、`1` の本体には `addCommand` の `slash` などがなく、`2` の本体には `broadcast` / `addStatusBarItem` / `holdBackground` がなく、`3` の本体には `holdBackground` の `actions` / `update` がない。`disnans.audio` は `5` から） |
| `apiVersion` | | このプラグインを作った（対象の）ホスト API のバージョン。省略すると `minApiVersion` とみなす。`minApiVersion` 以上の整数。本体がこれより新しく、その後に削除・意味を変えた API があると、読み込んだうえで設定の一覧に警告が出る（→ [互換](distribution.md#互換apiversion-と削除の警告)） |
| `icon` | | プラグインのアイコン。[Lucide](https://lucide.dev/icons/) のアイコン名（`dice-5` など。英小文字・数字・ハイフン、64 文字まで） |
| `permissions` | | 使う権限の配列（v15）。`"files"` で共有フォルダ（`this.files`）。入れていないと、その API は `permission_denied` で失敗する。知らない名前は無視される（→ [共有フォルダ](runtime.md#共有フォルダfilesv15)） |

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
「＋」メニューや補完の既定のアイコンに出ます（→ [PLUGIN_UI.md の「アイコン」](ui.md#アイコン)）。
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
| `this.postMessage({ body, name?, notify? })` | ボットとしてメッセージを投稿する（v5）。投稿者は自分のままで、名前は `name`（省略するとプラグインの名前）。`notify: true`（v6）なら、通常の宛先に加えて投稿した本人にも通知が届く（文言はボットの名前）。省略すると通知は送らない。例: `examples/bot`。失敗が `unknown_outcome` のときは送信済みかどうか分からない。再送は plugin が判断する（二重投稿に注意） |
| `this.openSettings()` | このプラグインの設定画面を開く（v6）。設定タブに切り替える |
| `this.broadcast(name, payload)` / `this.onBroadcast(name, cb)` | セッションに紐づかない一時的なイベント（v3）。いまつながっている人に届く |
| `this.addStatusBarItem()` | 常時表示のステータス欄（画面上部の枠。通話のバーと同じ）に出す要素（v3） |
| `this.holdBackground({ microphone, actions, onAction })` | 画面を切っても動き続ける（v3。Android のフォアグラウンドサービス）。通知のボタンと `update()` は v4 |
| `this.addMessageAction(action)` | メッセージの長押しメニュー・ホバーのツールバーに項目を足す（v9。→ [メッセージの操作とタイムライン](commands.md#メッセージの操作とタイムラインv9)）。例: `examples/messages` |
| `this.openTimeline(opts)` | メッセージの集合を、本体のメッセージ表示のままパネルに出す（v9。同上） |
| `this.addSettingTab(tab)` | プラグインの設定画面（設定 → プラグインの一覧で、トグルの右の歯車から開く） |
| `this.addIcon(name, svg)` | 独自のアイコンを登録する（→ [PLUGIN_UI.md](ui.md#addicon独自のアイコン)） |
| `this.loadData()` / `this.saveData(data)` | そのデバイスにだけ保存するデータ |
| `this.register(cleanup)` / `this.registerDomEvent(...)` / `this.registerInterval(id)` | 後始末を自動で行う登録 |
| `disnans.ui.*` | 本体と同じ見た目の部品とアイコン（→ [PLUGIN_UI.md](ui.md)） |
| `disnans.PluginError` | 本体が投げる例外（`code` 付き。→ [エラー](views.md#エラーdisnanspluginerrorv14)） |
| `session.viewers` / `session.onViewers(cb)` | セッションを開いている人（v14。→ [開いている人](views.md#開いている人viewersv14)） |
| `disnans.VersionConflictError` | `session.update` がぶつかったときのエラー（`PluginError` の一種。code は `version_conflict`） |
| `disnans.audio.listOutputs()` / `setOutput(id)` / `listInputs()` / `attach(el)` | 音の入出力の選択（v5）。Android は通話中の出力先（受話口・スピーカー・イヤホン・Bluetooth）、デスクトップは `setSinkId`。使えない環境では一覧が空 |
| `disnans.call.*` | 本体の通話の状態の読み取りと、参加者どうしのデータの送受信、通話のバーのボタン（v7）、通話の画面の領域と送信待ちの量（v10。→ [通話の拡張 API](call.md#通話の拡張-apidisnanscallv8)） |
| `disnans.ui.onBack(handler)` / `ui.setImmersive(on)` | 戻る操作（Android の戻るジェスチャー・PC の Alt+←）で閉じる層を足す／Android で全画面（システムバーを隠す没入モード）にする（v9。→ [画面共有のためのネイティブ API](call.md#画面共有のためのネイティブ-apiv9)） |
| `disnans.screenCapture.*` / `disnans.pip.*` | Android の画面のキャプチャ（MediaProjection）と、ピクチャーインピクチャー（v9。同上）。Linux の画面のキャプチャは portal / PipeWire（v12）。ダイアログなしの静止画 `screenCapture.snapshot()`（v11。デスクトップでも使える） |
| `this.files` | 共有フォルダ（v15。権限 `files` が要る。→ [共有フォルダ](runtime.md#共有フォルダfilesv15)） |
| `disnans.apiVersion` | ホスト API のバージョン（いまは 15） |
