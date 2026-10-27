# view・カード・セッション・エラー

この文書はプラグインの作り方（[README.md](README.md)）の一部です。

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
- view の中にタブを作るなら `disnans.ui.navbar`、選択肢なら `disnans.ui.segmented` が使えます（→ [PLUGIN_UI.md](ui.md)）
- 毎回まるごと描き直す（`replaceChildren`）のがもっとも短い書き方です。state は小さいので十分速く動きます

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

### エラー（disnans.PluginError、v14）

本体が投げる例外は `disnans.PluginError` です。`code` は機械向けの語で、分岐に使えます。`message` は表示用の文です（変わることがあります）。

| code | 意味 |
|---|---|
| `version_conflict` | `session.update` が他の人の更新とぶつかった（`disnans.VersionConflictError` の code） |
| `disconnected` | サーバーに届かなかった（通信の失敗） |
| `not_loaded` | プラグインが本体に読み込まれていない |
| `invalid_argument` | 渡された値が正しくない（例: `messages` と `messageIds` の両方） |
| `not_found` | 指定されたもの（view の種類など）が本体にない |
| `stopped` | プラグインが外された、またはセッションがもう使えない |
| `unsupported` | この環境では使えない（例: 画面を撮る機能のない環境） |
| `permission_denied` | manifest.json の `permissions` に無い権限の API を呼んだ（例: 共有フォルダは `files`）（v15） |
| `failed` | 上のどれでもない、本体側の失敗 |
| そのほか | サーバーのエラーは、サーバーの code をそのまま使う（例: `not_found`、`invalid_plugin_id`） |

```js
try {
  await this.sessions.get(id);
} catch (e) {
  if (e instanceof disnans.PluginError && e.code === 'not_found') { /* ない */ }
  else throw e;
}
```

`disnans.VersionConflictError` は `PluginError` の一種なので、`instanceof disnans.PluginError` でも見分けられます（`code` は `version_conflict`）。
v13 以前の本体には `disnans.PluginError` がありません。これを使うプラグインは `minApiVersion` を `14` にしてください。

#### 開いている人（viewers、v14）

セッションのビュー（パネル）を開いている人は `session.viewers`（ユーザー ID の一覧。自分を含む）で分かります。開いた・閉じたは本体が知らせるので、プラグインは何もしなくてかまいません。変わったときは `session.onViewers` で受け取ります。

```js
const off = session.onViewers((ids) => {
  this.renderViewers(ids); // ids は ユーザー ID の配列
});
```

- 開いていない人（カードだけ見ている人）は含みません
- 接続し直したあとも、開いたままのものは、本体が開いた状態に戻して知らせます
- 外したあと（プラグインが外れたら）は届きません
