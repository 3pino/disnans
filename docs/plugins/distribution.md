# 配布・更新・削除・互換・注意点

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

## 配布・更新・削除と、デバイスごとのオンオフ

すべて **設定 → プラグイン** の一覧で行います。

| 操作 | どうなるか |
|---|---|
| **[配布] → みんなに配布** | サーバーに上がり、つながっている全員のクライアントで動き始める（チャットにお知らせは流れない） |
| **[配布] → 自分だけに配布** | サーバーに上がり、**自分のすべてのデバイス**（Android を含む）でだけ動く。ほかの人の一覧には出ない。一覧に「自分だけ」と出る |
| **更新**（同じ `id` でもう一度 [配布]） | 上書きになる。サーバーが配信するのは常に1つの版。全員（自分だけなら自分のデバイス）のクライアントで読み込み直す。範囲も選び直せる |
| **削除** | 全員（自分だけなら自分のデバイス）のクライアントから外れる。セッションとカードは残る（同じ `id` で配布し直せば、また開ける） |
| **オン / オフ**（トグル） | **自分のデバイスでだけ**切り替える（そのデバイスに保存）。配布されたプラグインは既定でオン |

- みんなに配布したものの更新・削除は誰でもできます。最後に配布・更新した人は一覧の情報（`updated_by`）に残ります
- 自分だけのものは、配布した人（`owner`）だけが更新・削除できます
- `id` はプラグインとテーマ、みんなのものと自分だけのものを通して一意です。ほかの人が自分だけに配布しているものと同じ `id` は使えません（`409 plugin_id_taken`。`id` を変えてください）
- 自分だけのプラグインを、あとから「みんなに配布」し直すこともできます。逆に、みんなのものを「自分だけに配布」し直すと、ほかの人のデバイスからは外れます
- 自分だけのプラグインでもセッションとカードは作れます。ただし、カードはチャットに流れて全員に見える一方、ほかの人のデバイスにはそのプラグインがないので、標準のカード（最後の内容を表示するだけで、タップしても開かない）になります
- 開発用フォルダに、配布済みと同じ `id` のプラグインがあれば、自分のデバイスでは開発中のほうが動きます。配布した版を直すときは、そのまま開発用フォルダで直して [配布] すれば更新になります
- 壊れたプラグインが配られても、各自がトグルでオフにできます
- テーマ（`theme.css` だけのパッケージ）も同じ方法で配れます。作り方は [THEMES.md](../themes.md) を見てください

---

## 互換（apiVersion と削除の警告）

本体は、削除した・意味を変えた API の表（版ごと）を持っています。

| 版 | 変わったこと |
|---|---|
| 13 | スレッドの API が削除されました |
| 14 | エラーの形が変わりました（`disnans.PluginError` と `code`） |

- manifest の `apiVersion` は、そのプラグインを作った（対象の）版です。省略すると `minApiVersion` とみなします。新しい API を使って作り直したら、`apiVersion` をその版に上げてください
- 本体がプラグインの対象の版より新しく、その後に削除・変更があると、プラグインは**読み込まれたまま**、設定 → プラグインの一覧に警告が出ます。例: 「このプラグインは v12 向けです。v13 でスレッドの API が削除されました」
- 警告は「動かないかもしれない」という知らせです。動いていれば無視してかまいません
- `minApiVersion` より古い本体では読み込まれません（これは従来どおり）

## API を追加した版

`minApiVersion` に書く版の目安です。削除・意味の変更は上の表（コードの `API_CHANGES`）が正で、ここは追加の一覧です。

- 2: `addCommand` の `icon`・`slash`・`run(ctx)`
- 3: `broadcast` / `onBroadcast`・`addStatusBarItem`・`holdBackground`
- 4: `holdBackground` の通知のボタン `actions` / `onAction` と `update()`
- 5: `disnans.audio`・`postMessage`
- 6: `postMessage` の `notify`・`openSettings`
- 7: `disnans.call`（通話の状態の読み取り・通話のバーのボタン）
- 8: `disnans.call` の参加者どうしのデータの送受信。v7 にあった WebRTC のトラックの API（`addTrack` など）は外れた
- 9: `addMessageAction` / `openTimeline`・`disnans.screenCapture` / `disnans.pip`・`ui.onBack` / `ui.setImmersive`
- 10: 通話の画面の領域 `call.addPanel`・送信待ちの量 `call.bufferedAmount`
- 11: ダイアログなしの静止画 `screenCapture.snapshot`
- 12: 通話画面だけに出すボタン `call.addButton({ location: 'view' })`・Linux のネイティブ画面取得（portal / PipeWire）
- 14: `disnans.PluginError`・`session.viewers`
- 15: 共有フォルダ `this.files`

## 注意点

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
