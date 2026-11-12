# 通話の拡張 API

この文書はプラグインの作り方（[README.md](README.md)）の一部です。型の契約は [`index.d.ts`](../../packages/plugin-sdk/index.d.ts) にあります。

**通話・画面共有・カメラ共有はアプリ本体の標準機能です。** プラグインの導入や有効化は不要です。所有関係・設定移行は [標準の画面共有](../design/call-screen.md) を参照してください。旧 `screenshare` プラグインは本体が読み込みません。

以下の API は、通話に別の操作やデータのやり取りを追加するためのものです。本体の標準機能はこれらのプラグイン API を経由しません。

## 通話の拡張 API（disnans.call、v8）

```js
const { call } = disnans;
call.joined;
call.participants; // [{ peer, user, self, muted, deafened, connected, speaking, device }]
await call.join(); // 失敗は本体がトーストで知らせる
call.leave();
```

- `onChange(cb)`: 参加・退出・参加者・ミュート・発話などの変化。頻繁に呼ばれるため、重い処理は避けてください。
- `emit(name, payload)`: 自分以外の参加者へ、保存しない JSON をサーバー経由で送ります。名前は 1〜64 文字、`audio` は本体用です。payload は 64 KB まで。通話にいなければ例外です。流量制限（音声を含め毎秒約 3 MB）や受け手の送信待ちにより、データが捨てられることがあります。
- `onEvent(name, ({ peer, user, payload }) => ...)`: データの受信。自分の送信は届きません。同じユーザーの複数デバイスは `peer` で区別します。
- `addButton({ icon, label, onClick, active?, disabled?, location? })`: 通話のバーと画面への追加操作。`location: 'view'`（v12）は通話画面だけに表示します。戻り値の `update(patch)` / `remove()` で変更・解除できます。
- `addPanel({ label, order? })`（v10）: 通話画面への追加領域。戻り値の `el` に内容を作り、`setVisible(true)` で表示します。`mounted` / `onMount(cb)` で文書内にあるかが分かります。画面を閉じても内容は保たれ、`remove()` で解除します。
- `bufferedAmount`（v10）: サーバーへ送信待ちのバイト数。最新のデータだけが重要な処理では、多い間は次を送らず待ってください。

コールバックの購読解除や追加した UI の `remove()` は、`this.register(...)` へ登録して片付けます。

```js
const button = call.addButton({
  icon: 'hand', label: '合図を送る',
  onClick: () => call.emit('signal', { kind: 'hand' }),
});
this.register(() => button.remove());
this.register(call.onEvent('signal', ({ user }) => disnans.ui.toast(`${user.display_name}さんから合図`)));
```

## 全画面と戻る操作（v9）

Android の全画面は `await disnans.ui.setImmersive(true)`、戻すときは false。非対応なら false が返るので Fullscreen API を利用します。戻る操作の購読は `ui.onBack(handler)` で、登録の解除は `this.register(...)` に渡します。

## 画面のキャプチャの削除（v17）

v17 で `disnans.screenCapture`（画像取得・静止画・`callRelay`）と `disnans.pip` を削除しました。画面共有は本体の標準機能で、プラグインから画面を取得・中継する API はありません。デスクトップの小窓には `<video>` の `requestPictureInPicture()` を使えます。旧 `screenshare` プラグインは本体が読み込みません。
