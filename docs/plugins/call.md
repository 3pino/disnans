# 通話の拡張とメディア取得 API

この文書はプラグインの作り方（[README.md](README.md)）の一部です。型の契約は [`index.d.ts`](../../packages/plugin-sdk/index.d.ts) にあります。

**通話・画面共有・カメラ共有はアプリ本体の標準機能です。** プラグインの導入や有効化は不要です。所有関係・設定移行は [標準の画面共有](../design/call-screen.md) を参照してください。旧 [`examples/screenshare/`](../../examples/screenshare/) は旧クライアントとの互換試験用であり、現在の実装例ではありません。

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

## 画面共有のためのネイティブ API（v9）

汎用の画像取得は引き続き公開します。Android は MediaProjection、Linux は portal / PipeWire → GStreamer を使います。Windows の継続取得は `getDisplayMedia`、静止画は本体の API を利用できます。選んだソースを、別の画面やアプリの静止画へ黙って置き換えません。

```js
const { screenCapture, pip } = disnans;
if (screenCapture.supported) {
  await screenCapture.start({ maxEdge: 1280, quality: 0.6, fps: 5,
    color: 'full', onEnd: () => onStopped() }, (frame) => processFrame(frame));
  await screenCapture.update({ quality: 0.5, scale: 0.8 });
  await screenCapture.stop();
}
```

- `start` は利用者の操作から呼び、OS の許可／選択を求めます。キャンセルは `name: 'AbortError'`（v10）です。許可なしに自動で再開しません。
- `supported` は Android・Linux のアプリで true。フレームは `{data, mime, width, height}`、`data` は接頭辞なしの base64 です。
- `format` は `jpeg` / `webp`、`color` は `full` / `c256` / `gray`。変化を検出し、静止中も `keepaliveMs`（既定 5000）ごとに送ります。`diffThreshold` の既定は 1.5。減色時は PNG・WebP などを比較します。Linux は JPEG のみです。
- Linux は選択したソースから最初のフレームを取れなければ開始失敗とします。AppImage は関連ライブラリを同梱、deb は依存に指定します。OS 側には適切な portal バックエンドが必要です。
- `onEnd` は通知や OS の操作で終了した場合に呼ばれ、`stop()` では呼ばれません。
- 本体の標準共有と拡張の取得は同時に開始できません。他方が取得中の `start` は `PluginError` の `code: 'busy'`。拡張の `stop` / `update` は、本体が所有する取得を変更しません。
- 次の開始は、前の停止が受理されるまで待ちます。停止を確認できなければ `stop_unconfirmed` で失敗し、取得の所有者から再び `stop()` してください。失敗を停止成功とみなして新しい取得を重ねません。

### 静止画（v11）

`await screenCapture.snapshot()` は `{dataUrl,width,height,source}` を返します。選択・許可のダイアログや継続取得を始めません。`supported` に関係なくアプリで使えます。

- Windows と Linux の X11 は主画面（`source: 'screen'`）。
- Android・Linux の Wayland などは disnans 自身（`source: 'app'`）。Android は PixelCopy を使い、MediaProjection を開始しません。
- 長辺 1920 以下の JPEG。取得不能なら例外です。

### PiP と全画面

Android は `pip.supported` が true。`pip.enter({aspect:{width:16,height:9}})` で Activity を小窓にし、`pip.onChange(cb)` で状態を受け取ります。それ以外は false で、デスクトップの小窓には `<video>` の `requestPictureInPicture()` を使います。

Android の全画面は `await disnans.ui.setImmersive(true)`、戻すときは false。非対応なら false が返るので Fullscreen API を利用します。戻る操作の購読は `ui.onBack(handler)` で、登録の解除は `this.register(...)` に渡します。

## Android の通話へ直接中継する（v16、互換 API）

独自の画像ストリームなどでは、`supportsCallRelay === true` の場合に `start` の `callRelay` を指定できます。通話への参加と取得の許可が必要です。使えなければ失敗し、JS 送信へ黙って切り替えません。

```js
await screenCapture.start({ maxEdge: 1280, quality: 0.6, fps: 5,
  callRelay: { frameEvent: 'example.frame', stateEvent: 'example.state',
    queryEvent: 'example.query', state: { source: 'screen' } },
}, (frame) => updatePreview(frame));
```

前景・背景とも、画像片 `{f,i,n,d}`、状態 `{on:true,...state}` / `{on:false}`、問い合わせの応答をネイティブが送ります。JS から重ねて送らないでください。`onFrame` は前景のプレビュー用です。イベント名は互いに異なる 1〜64 文字、`audio` は不可。追加状態は `on` を含まない文字列・有限の数・真偽のオブジェクトで、JSON の UTF-8 で 256 バイト以内です。

中継は通話・世代・取得番号に結び付きます。同じ通話の再接続中は待ち、取得終了・退出・別の通話で終了します。OS の画面ロック等の終了条件を無効化したり、取得を自動再開したりしません。Windows・Linux や v15 以前では使えません。任意に利用するなら対応を調べて一方の送信方式だけを選び、必須なら `minApiVersion: 16` を指定します。サービスの常駐だけでは JS の凍結を防げません。
