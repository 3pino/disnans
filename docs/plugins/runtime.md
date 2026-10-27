# 一時的なイベント・通知・設定・共有フォルダ・保存

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

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
`registerInterval` / `registerDomEvent` で登録すると、プラグインを外すときに本体が止めてくれます（→ [後始末は register* で](distribution.md#後始末は-register-で)）。

```js
this.registerInterval(window.setInterval(() => this.tick(), 80)); // 開いている view の tick() を呼ぶ
// アプリが裏に回るとタイマーが間引かれるので、そこで演出を終える
this.registerDomEvent(document, 'visibilitychange', () => {
  if (document.hidden) for (const view of this.openViews) view.stopShaking();
});
```

### プラグイン全体の一時的なイベント（broadcast、v3）

`session.emit` は、先にセッション（とチャットのカード）を作らないと使えません。短い合図のように、**カードを作らず、いまつながっている人に届けばよいもの**には `broadcast` を使います。

```js
// 送る。自分には届かない（自分の別のデバイスには届く）。payload は JSON にできる値で、64 KB まで
this.broadcast('presence', { peer: 'abc', muted: false });

// 受け取る。from は送った人。外すときに自動で外れる（戻り値の関数でも外せる）
const off = this.onBroadcast('presence', (payload, from) => { /* ... */ });
```

- 保存しません。オンラインの人にだけ届き、あとから来た人には届きません（来た人に今の状態を知らせたいときは、定期的に送る・来た人に気づいたら送る、などをプラグインでします）
- 宛先は選べず、**プラグイン ID が同じなら全員に**届きます（そのプラグインを入れていない人のデバイスでは、何も起きません）。1人宛てにしたいときは payload に宛先を入れ、受け取る側で見分けます
- 名前は 64 文字まで。ネットワークが切れている間のイベントは失われます

### ステータス欄（addStatusBarItem、v3）

画面の最上部の共通の枠（トップバーのスロット。通話のバーも同じ枠に出ます）に、プラグイン共通の**常時表示の帯**として要素を足します。画面（チャット・設定）を切り替えても出ています。

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

### 共有フォルダ（files、v15）

全員で共有する 1 つのフォルダ（サーバーの `/api/shared`。WebDAV と同じ中身）を読み書きします。型は [`index.d.ts`](../../packages/plugin-sdk/index.d.ts) の `Files` / `SharedEntry`。

使うには manifest.json に権限と版を書きます。

```json
{
  "id": "notes",
  "name": "メモ",
  "version": "1.0.0",
  "description": "共有フォルダにメモを残す",
  "author": "me",
  "minApiVersion": 15,
  "permissions": ["files"]
}
```

```js
const { Plugin } = disnans;
export default class extends Plugin {
  async onload() {
    const list = await this.files.list('notes');        // フォルダの中身（省略か空で直下）
    await this.files.mkdir('notes');                    // フォルダを作る
    await this.files.write('notes/a.txt', 'こんにちは'); // 作成・上書き（Blob・ArrayBuffer・文字列）
    const text = await (await this.files.read('notes/a.txt')).text();
    this.files.onChange(({ path }) => {                 // 変わったパス（どのデバイスの変更でも）
      if (path.startsWith('notes/')) this.refresh();
    });
  }
}
```

- 操作: `list(path?)`・`stat(path)`・`read(path)`（Blob）・`write(path, data)`・`mkdir(path)`・`remove(path)`（フォルダは中身ごと）・`move(from, to, { overwrite? })`・`copy(from, to, { overwrite? })`。`onChange(cb)` は解除関数を返します（プラグインを外すと自動で解除）
- パスは共有フォルダからの相対（`docs/a.txt`）。区切りは `/`。空の区切り・`.`・`..` は `invalid_argument`。`read` はファイルだけ（フォルダは `invalid_argument`）
- `move` と `copy` は、同名のファイルがあると `exists`（409）で失敗します。上書きするには `{ overwrite: true }` を渡します（フォルダへの上書きは `forbidden`）
- `attachments/` は読み取り専用（投稿された添付が並ぶ。`message_id`・`mime` が入る）
- `SharedEntry` の `size`・`modified`（ミリ秒）は数です
- 失敗は `disnans.PluginError` で、`code` はサーバーの code（`not_found`・`forbidden`・`exists`・`parent_missing`・`too_large`・`insufficient_storage`）。権限がなければ `permission_denied`
- 権限を入れていないプラグインは、どの操作も `permission_denied` で失敗します（`onChange` は同期で投げます）
- 作るとき `minApiVersion` を `15` にしてください（`14` 以下の本体には `this.files` がありません）

### loadData / saveData

そのデバイスにだけ保存するデータ（設定など）です。ほかのメンバーとは共有されません。共有したいものはセッションに入れます。

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
すべての関数・オプション・例と CSS クラスは [PLUGIN_UI.md](ui.md) にまとめてあります。

```js
const { ui } = disnans;
ui.button({ text: '振る', icon: 'dices', variant: 'primary', onClick: () => this.roll() });
ui.toast('設定を初期値に戻しました');
```
