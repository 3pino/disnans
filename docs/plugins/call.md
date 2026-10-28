# 通話の拡張と画面共有のネイティブ API

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

### 通話の拡張 API（disnans.call、v8）

通話（ボイスチャット）は**アプリ本体の機能**で、プラグインではありません（参加・ミュート・出力先などは本体の画面と設定にあります）。
画面共有のような機能を足せるように、本体の通話に次の API を用意しています。型は [`index.d.ts`](../../packages/plugin-sdk/index.d.ts) の `Disnans.Call`。
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
- **通話のボタン**: `call.addButton({ icon, label, onClick, active?, disabled?, location? })` で、通話のバー（参加中だけ表示）と通話の画面の操作の列にボタンを足します。`location: 'view'`（v12）を指定すると通話の画面だけに出ます（既定は `'both'`）。戻り値の `update(patch)` / `remove()` で変えたり外したりします。押したボタンは本体がフォーカスを外します
- **通話の画面の領域（v10）**: `call.addPanel({ label, order? })` で、通話の画面（「通話を開く」で出る全画面の通話タブ）の参加者の上に領域を足します。戻り値の `el` にプラグインが中身を書き、`setVisible(true)` で出します（既定は隠れている。参加中だけ出る）。`el` は通話の画面が開いている間だけ文書に入り、閉じても中身は保たれます。入った・外れたは `onMount(cb)`（`mounted` でも読める）で分かるので、大きさを測り直すなどに使います。`remove()` で外します
- **送信待ちの量（v10）**: `call.bufferedAmount` は、サーバーへまだ送り出せていないバイト数（WebSocket の `bufferedAmount`）です。回線より速く送るとここに溜まり、そのぶん相手に遅れて届きます。映像のように新しいものだけが大事なデータは、これが多いあいだ次を作らずに待つと遅延が減ります
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

実例は **画面共有**（[`examples/screenshare/`](../../examples/screenshare/)、v12）です。通話の全画面のボタンから画面を取り、縮小した画像（JPEG / WebP / PNG）にして `call.emit` で送ります。上部の通話バーの全画面ボタンでこの画面を開けます。 カメラを共有中に、前後のカメラが 2 つ以上あるデバイスでは、通話の画面の領域に出る自分の映像の右上の [カメラを切り替え] で前と後ろを切り替えます（開けなければ、いまのカメラのまま続けます）。配信する人も見る人も、同じ大きさの舞台に映像を出します。通話の画面では、参加者の一覧を上に、プラグインの領域（画面共有の舞台）を下に置き、舞台の高さは画面の高さの 38% まで（最大 420px）です。

- 取る側: `disnans.screenCapture` が対応していれば優先します（Android の MediaProjection、Linux の portal / PipeWire → GStreamer。v12）。Linux は WebKitGTK の `<video>` の描画を通さず、OS のダイアログで選んだ画面を取得します。Windows は WebView2 の `getDisplayMedia` を使います。どちらも無ければ共有ボタンを出さず、見るだけです
- カメラ: [カメラを共有]（アイコン `video`）を押すと、`getUserMedia` で開いたカメラの映像を画面と同じ流れで送ります。画面とカメラは同時には送らず、押したほうに切り替わります。共有の知らせ（`screen.state`）に `source: 'camera'` を付けるので、見る側は「○○のカメラを見る」と出します（`source` の無い前の版は画面として扱う）。送信中は通話の画面の領域に「自分のカメラ（送信中）」を出し、同じ映像を確認できます（音は再生しない・新しい取得はしない）
- 送る側: 1 回の payload の上限（64 KB）を超えるフレームは分割して送り（`{ f: フレーム番号, i, n, d: base64 の一部 }`）、受け手が組み立てます（欠けたフレームは捨てる）。画像の形式は先頭のバイトから見分けるので、送り手は JPEG・WebP・PNG のどれでも送れます。サーバーの流量制限（容量 4000・毎秒 3000 回復・1 回の重さ = 1 + payload の KB）に収まるよう、映像の予算を毎秒 2400 KB（重さ）にして、直前のフレームの大きさから次の間隔を決め、大きすぎれば画質→解像度の順に下げ、画面が変わらなければ送りません（変化は 64×36 に縮めた画像の平均の差と、1 画素の最大の差で見るので、文字の入力のような小さな変化も送る）。送信待ち（`call.bufferedAmount`）が 192 KB を超えているあいだは次のフレームを作らずに待ちます（回線が細いときに古いフレームを溜めない）
- 参加: 通話に入った人（とプラグインを読み込み直した人）は `screen.query` を送り、共有中の人は `screen.state` とフレームをすぐに送り直します。新しい参加者が来たときも、共有中の人はハートビートを待たずに知らせます。問い合わせは 1 秒ごとに 2 回だけ再送します。ネイティブの最初のフレームが開始応答より先に届いても保持して送ります
- 取り込めないとき: Linux の WebKitGTK などで、文書に入っていない `<video>` を canvas に描けないことがあるので、取り込み用の `<video>` を見えない大きさで文書に入れています。それでも映像が来ない・空（全部透明）のままなら、`ImageCapture` があればそれに替え、だめならログ（`[screenshare]`）とトーストで知らせます
- 設定: FPS（5 / 20）、画質（480p・品質 50% / 720p・品質 60% / 1080p・品質 80%）、色数（フルカラー / 256 色 / グレースケール）。色数を減らす設定では、減色した画像を PNG・WebP・JPEG のうち小さいもので送ります（JPEG は減色の効果が薄いため）。設定画面に、今の設定で符号化した画像と 1 フレームのおおよそのサイズ・帯域のプレビューがあります。元は自分の実際の画面で、共有中ならその画面、そうでなければ設定を開くたびに `screenCapture.snapshot()`（v11）で 1 枚撮ります（選択や許可のダイアログは出ない。Windows と Linux の X11 は画面全体、Wayland と Android は disnans 自身の画面。撮れなければプレビューなしで文言だけ。「画面を取り込み直す」で撮り直せる）
- 見る側: プラグインが `document.body` に全画面のオーバーレイを足して表示します（ダイアログ・トーストより下、Esc でも閉じる）。通話の画面にも `call.addPanel` で配信を出し、「大きく見る」でオーバーレイを開きます。共有者が複数ならタブで切り替えます。既定は画面全体が収まる表示（縦長のスマホの画面も切れない）。ピンチ・Ctrl+ホイール（トラックパッドのピンチ）でカーソルの位置を中心に拡大縮小、拡大中はドラッグ・ホイールで移動（Shift+ホイールで横）、等倍のときにホイールを上へ回すと拡大、ダブルタップ（ダブルクリック）で拡大／元に戻す、`+` / `-` / `0` キーでも拡大・縮小・元に戻す。全画面は `ui.setImmersive`（Android）か Fullscreen API、戻るジェスチャーは `ui.onBack` で全画面の解除→閲覧を閉じる、の順。PiP は Android なら `disnans.pip`、デスクトップなら受け取った画像を `<canvas>` に描いて `captureStream()` した `<video>` の `requestPictureInPicture()`

本体の通話のしくみ（参加者の管理と kick はサーバー、音声とデータもサーバー経由）は、サーバーの経路と合わせて [`API.md`](../api/rest.md) の通話の節と WebSocket を参照してください。
マイクを使うには**アプリ版（Tauri）が必要**です（本体は Tauri 版だけを製品として配るので、通常のブラウザーで開く使い方はありません）。

---

### 画面共有のためのネイティブ API（v9）

画面共有の実例が使う、本体の API です。Android の WebView には `getDisplayMedia` も Fullscreen API も無いため、ネイティブの機能を本体が包んで渡します。Linux では portal / PipeWire の取得も本体で受け持ちます（v12）。型は [`index.d.ts`](../../packages/plugin-sdk/index.d.ts)。

```js
const { ui, screenCapture, pip } = disnans;

// 戻る操作で閉じる層。戻る操作のたびに、新しいものから 1 つずつ handler が呼ばれる（本体のパネルなどより先）
const off = ui.onBack(() => close());
this.register(off);

// 全画面。Android はシステムバーを隠す没入モード（true）。ほかの環境では何もせず false なので Fullscreen API を使う
if (!(await ui.setImmersive(true))) await el.requestFullscreen();

// Android: MediaProjection、Linux: portal / PipeWire で画面を撮る（OS の確認が出る）
if (screenCapture.supported) {
  await screenCapture.start(
    { maxEdge: 1280, quality: 0.6, fps: 5, color: 'full', onEnd: () => onStopped() },
    ({ data, mime, width, height }) => send(data), // data は base64
  );
  await screenCapture.update({ quality: 0.5 }); // 撮りながら変える
  await screenCapture.stop();
}

// 静止画を 1 枚（v11）。選択や許可のダイアログを出さない。supported に関係なくアプリ版（Tauri）で使える
try {
  const { dataUrl, width, height, source } = await screenCapture.snapshot(); // source: 'screen'（画面全体）| 'app'（disnans 自身）
  img.src = dataUrl;
} catch {
  // 撮れない環境（対象外のデバイスなど）
}

// Android: Activity の PiP（小窓）。小窓の間はアプリの画面がそのまま小さく出るので、onChange で表示を切り替える
if (pip.supported) {
  this.register(pip.onChange((active) => setCompact(active)));
  await pip.enter({ aspect: { width: 16, height: 9 } });
}
```

- `screenCapture.start` は、断られたら例外です。ユーザーが許可のダイアログでキャンセルしたときの例外は `name` が `AbortError` です（v10。知らせずに終えてください）。フレームは、画面が変わったときと、変わらなくても `keepaliveMs`（既定 5 秒）ごとに 1 枚届きます。`color` が `c256` / `gray` のときは、減色したうえで可逆の WebP（Android 11 以降。それ以前は PNG）と lossy の WebP を比べて小さいほうを渡します
- Linux の `start` は OS の画面・ウィンドウ選択を使い、選んだソースだけを共有します（主モニターや disnans の静止画に勝手に置き換えません）。GStreamer の行の詰め物を考慮して RGBx を読み、縮小・減色・変化の検出を行い JPEG にします（Linux では `format: 'jpeg'` のみ）。`update({ quality, scale })` は静止した画面にも効きます。最初の実際のフレームが取れなければ開始を失敗として片付けます。AppImage は GStreamer / PipeWire プラグインを同梱し、deb は GStreamer・PipeWire プラグインと portal を依存に含めます。OS 側にはデスクトップに合った portal バックエンドが必要です
- `onEnd` は、通知欄の「停止」やシステム側の操作で止められたときに呼ばれます（`stop()` では呼ばれません）
- `screenCapture.snapshot()`（v11）は、設定のプレビューのような「いまの画面を 1 枚だけ見たい」用途向けです。`getDisplayMedia` や `start` と違って、どの画面を共有するかの選択も許可のダイアログも出しません。撮れるものは環境で違い、`source` で分かります: Windows は主モニター全体（GDI）、Linux は X11 なら主モニター全体（ルートウィンドウ）で Wayland などでは disnans 自身の画面（WebKitGTK のスナップショット）、Android は disnans 自身の画面（PixelCopy。MediaProjection は使わない）。長辺 1920 以下に縮めた JPEG の data URL を返します。対象外のデバイスでは例外です
- `screenCapture.supported` は Android / Linux のアプリ版で `true`、それ以外は `false` です。`pip.supported` は Android だけ `true` です。デスクトップの PiP は `<video>` の `requestPictureInPicture()` を使ってください
- 通話中にアプリを裏に回しても共有が続くのは、通話のフォアグラウンドサービス（マイク）と、画面のキャプチャのフォアグラウンドサービス（`mediaProjection`）が動いているためです
