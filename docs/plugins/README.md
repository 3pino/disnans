# プラグインの作り方

disnans のプラグインは、Obsidian のプラグインに近い仕組みです。JS のファイルを1つ書けば動き、ボタン1つで全員に配れます。
このガイドは、実例の **ダイス**（[`examples/dice/`](../../examples/dice/)）を題材に説明します。
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

使っていないのは `notify` だけです（カードの書き換えで足りるため。→ [通知](runtime.md#通知)）。

- 設計: 仕組みと配り方は、このファイルの各章と [`API.md`](../api/rest.md) を正とする
- 型定義: [`packages/plugin-sdk/index.d.ts`](../../packages/plugin-sdk/index.d.ts)（API の細かい説明はここが正）
- UI 部品（`disnans.ui`）とアイコン: [`PLUGIN_UI.md`](ui.md)
- ホスト API のバージョン: **15**（`disnans.apiVersion`）。どの版で何が増えたかは [distribution.md の「API を追加した版」](distribution.md#api-を追加した版)
- 画面共有などの拡張は `disnans.call` で作れます（→ [通話の拡張 API](call.md#通話の拡張-apidisnanscallv8)）

## 目次

読む順序は、この README の「5分で動かす」→ 基本 → 必要なものです。

| 文書 | 内容 |
|---|---|
| この README | 5分で動かす |
| [basics.md](basics.md) | manifest.json・main.js の書き方・ライフサイクル・ホスト API の一覧 |
| [commands.md](commands.md) | コマンド（パレット・ホットキー・スラッシュ）・＋メニュー・メッセージの操作とタイムライン |
| [views.md](views.md) | view・カード・セッションと楽観ロック・エラー・開いている人 |
| [runtime.md](runtime.md) | 一時的なイベント・ステータス欄・バックグラウンド・通知・設定タブ・共有フォルダ・保存 |
| [call.md](call.md) | 通話の拡張 API・画面共有のネイティブ API |
| [styles.md](styles.md) | 見た目（CSS）・TypeScript で書く |
| [distribution.md](distribution.md) | 配布・更新・削除・オン/オフ・互換（apiVersion）・注意点 |
| [ui.md](ui.md) | `disnans.ui`（部品）とアイコン |

---

## 5分で動かす

### 1. 開発用フォルダを決める

PC 版（Windows / Linux）の **設定 → プラグイン → 開発用フォルダ** で、フォルダを選びます（例: `~/disnans-plugins`）。
このフォルダの中のプラグインは、**自分のデバイスでだけ**動きます。

> Android には開発用フォルダはありません。ファイルを選んで直接配布できます。

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
サーバーに上がり、つながっている全員（自分だけなら、自分のすべてのデバイス）のクライアントで動き始めます。
チャットにお知らせは流れません。

直したら、`version` を上げてもう一度 [配布] を押すと更新になります。

