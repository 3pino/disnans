# プラグインの作り方

disnans のプラグインは、Obsidian のプラグインに近い仕組みです。JS のファイルを1つ書けば動き、ボタン1つで全員に配れます。
このガイドは、実例の **ダイス**（[`examples/dice/`](../examples/dice/)）を題材に説明します。

- 設計: [`SPEC.md`](../SPEC.md) の 3.3 と 9章
- 型定義: [`packages/plugin-sdk/index.d.ts`](../packages/plugin-sdk/index.d.ts)（API の細かい説明はここが正）
- UI 部品（`disnans.ui`）とアイコン: [`PLUGIN_UI.md`](PLUGIN_UI.md)
- ホスト API のバージョン: **1**

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

ダイスを試すなら、`examples/dice/` をそのまま開発用フォルダにコピーしてもかまいません。

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

**設定 → プラグイン** の一覧で、そのプラグインの **[配布]** を押します。サーバーに上がり、つながっている全員のクライアントで動き始めます。
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
| `minApiVersion` | ○ | 必要なホスト API のバージョン。本体のほうが古ければ読み込まない。いまは `1` |
| `icon` | | プラグインのアイコン。[Lucide](https://lucide.dev/icons/) のアイコン名（`dice-5` など。英小文字・数字・ハイフン、64 文字まで） |

ダイスの manifest:

```json
{
  "id": "dice",
  "name": "ダイス",
  "version": "1.0.0",
  "description": "サイコロを振って、結果をみんなに見せる",
  "author": "sanpino",
  "minApiVersion": 1
}
```

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
    this.addSlashCommand({ /* ... */ });
    this.registerView('dice', (session) => new DiceView(this, session));
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
| `this.addSlashCommand(cmd)` | 入力欄の `/コマンド` |
| `this.addComposerAction(action)` | 入力欄の「＋」メニュー |
| `this.addCommand(cmd)` | キーボードショートカット（デスクトップ） |
| `this.registerView(type, factory)` / `this.openView(type, session)` | パネル（モバイルでは全画面）に出す画面 |
| `this.registerCardRenderer(render)` | カードの見た目 |
| `this.sessions.create(...)` / `this.sessions.get(id)` | セッション |
| `session.update(state, { card })` / `session.onChange(cb)` | 楽観ロック付きの保存、変更の購読 |
| `session.emit(name, payload)` / `session.on(name, cb)` | 保存しない一時的なイベント |
| `this.notify(userIds, text, { session })` | 通知 |
| `this.addSettingTab(tab)` | 設定画面のプラグインの欄 |
| `this.addIcon(name, svg)` | 独自のアイコンを登録する（→ [PLUGIN_UI.md](PLUGIN_UI.md#addicon独自のアイコン)） |
| `this.loadData()` / `this.saveData(data)` | その端末にだけ保存するデータ |
| `this.register(cleanup)` / `this.registerDomEvent(...)` / `this.registerInterval(id)` | 後始末を自動で行う登録 |
| `disnans.ui.*` | 本体と同じ見た目の部品とアイコン（→ [PLUGIN_UI.md](PLUGIN_UI.md)） |
| `disnans.VersionConflictError` | `session.update` がぶつかったときのエラー |
| `disnans.apiVersion` | ホスト API のバージョン（いまは 1） |

### スラッシュコマンドと補完

入力欄で行頭に `/` と打つと、プラグインが足したコマンドが補完に出ます（本体のコマンドはいまはありません）。
`/dice 2d6` のように送信すると、メッセージとしては送らずに `run({ args, threadId })` を呼びます。

```js
this.addSlashCommand({
  name: 'dice',                 // `/dice`。英小文字・数字・ハイフン
  description: 'サイコロを振る', // 補完に出る説明
  icon: 'dice-5',               // 補完に出るアイコン（省略するとプラグインのアイコン）
  args: '[個数]d[面数]',          // 引数の書き方のヒント
  // 引数の候補。input はコマンド名のあとに打った文字列
  suggestArgs: (input) =>
    ['1d6', '2d6', '1d20', '1d100']
      .filter((v) => v.startsWith(input.trim()))
      .map((value) => ({ value })),
  // args は前後の空白を除いた文字列（なければ ''）。threadId はスレッドで打ったときだけ入る
  run: ({ args, threadId }) => this.prepare(args, threadId),
});
```

- 入力の誤りは `disnans.ui.toast('…', 'error')` で知らせます。`run` が例外を投げた（reject した）ときも、本体がエラーのトーストを出します
- 候補（`Suggestion`）は `{ value, label?, description? }`。`value` が入力欄に入ります

### ＋メニュー

```js
this.addComposerAction({
  id: 'roll-2d6',
  label: 'サイコロ（2d6）',
  icon: 'dice-6', // アイコンの名前（省略するとプラグインのアイコン）
  run: ({ threadId }) => this.prepare('2d6', threadId),
});
```

`icon` は**アイコンの名前**です（Lucide の名前・`disnans-logo`・`addIcon` で登録した名前）。
独自の SVG を使うときは、先に `this.addIcon('dice-cup', '<path .../>')` で登録してから名前で指定します（→ [PLUGIN_UI.md](PLUGIN_UI.md#アイコン)）。

### コマンド（ショートカット）

```js
this.addCommand({
  id: 'quick-roll',
  name: 'サイコロ（1d6）を用意する',
  hotkey: 'Mod+Shift+D', // Mod は Ctrl（macOS では Cmd）
  run: () => this.prepare('', null),
});
```

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
    this.title = 'ダイス'; // パネルの上部の題名（省略するとプラグイン名。'' なら出さない）
    this.icon = 'dice-5';  // パネルの上部のアイコン（省略するとプラグインのアイコン。'' なら出さない）
  }

  /** @param {HTMLElement} containerEl @param {Disnans.ViewPanel} panel */
  onOpen(containerEl, panel) {
    this.panel = panel; // あとから panel.setTitle('ダイス（2d6）') / panel.setIcon('dice-6') で変えられる
    this.el = containerEl;
    this.unsubscribe = this.session.onChange(() => this.render()); // 誰かが更新したら描き直す
    this.render();
  }

  onClose() {
    this.unsubscribe?.();
  }

  render() { /* this.el.replaceChildren(...) */ }
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

```js
this.registerCardRenderer((el, card) => {
  // card は { sessionId, title, text }
  el.replaceChildren();
  const b = document.createElement('b');
  b.textContent = card.title;
  el.append(b, ' ', card.text);
});
```

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
async roll() {
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
}
```

ゲームでは「自分の番か」「その手はまだ有効か」を、やり直しのたびに最新の state で確かめてください。
友達同士なので、チート対策は考えません（state は誰でも書き換えられます）。

### 一時的なイベント

保存しないイベント（「考え中…」、カーソルの位置など）は、`emit` / `on` で中継だけします。途中で開いた人には届きません。

```js
// 送る（自分には届かない）
this.session.emit('thinking', { on: true });

// 受け取る。from は送った人
const off = this.session.on('thinking', (payload, from) => {
  this.showThinking(from.id, /** @type {{ on: boolean }} */ (payload).on);
});
// view の onClose で off() する
```

### 通知

```js
await this.notify([nextPlayerId], 'あなたの番です', { session: this.session });
```

`session` を渡すと、通知から開いたときにそのカードの場所を開きます。
ダイスのように、カードの書き換えで足りるときは通知は要りません（通知はうるさくなりがちなので、必要なときだけ）。

### 設定タブ

```js
async onload() {
  /** @type {{ defaultSpec: string } | null} */
  const saved = await this.loadData();
  this.settings = { defaultSpec: '1d6', ...saved };

  this.addSettingTab({
    display: (containerEl) => {
      disnans.ui.setting(containerEl, {
        name: '既定のサイコロ',
        description: '/dice だけで送ったときの個数と面の数',
        control: disnans.ui.input({
          value: this.settings.defaultSpec,
          placeholder: '1d6',
          onChange: async (value) => {
            this.settings.defaultSpec = value;
            await this.saveData(this.settings);
          },
        }),
      });
    },
  });
}
```

`display` は表示のたびに空の `containerEl` で呼ばれます。

### loadData / saveData

その端末にだけ保存するデータ（設定など）です。ほかのメンバーとは共有されません。共有したいものはセッションに入れます。

```js
/** @type {{ history: string[] } | null} */
const data = await this.loadData(); // なければ null
await this.saveData({ history: ['2d6', '1d20'] }); // JSON にできる値
```

### disnans.ui

本体と同じ見た目の部品（ボタン・トグル・入力欄・選択肢・タブのバー・区切り線・設定の行・アイコン・トースト・確認ダイアログ）です。
すべての関数・オプション・例と CSS クラスは [PLUGIN_UI.md](PLUGIN_UI.md) にまとめてあります。

```js
const { ui } = disnans;
ui.button({ text: '振る', icon: 'dice-5', variant: 'primary', onClick: () => this.roll() });
ui.toast('保存しました');
```

---

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

ダイスの `styles.css`（抜粋）:

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
| **[配布]** | サーバーに上がり、つながっている全員のクライアントで動き始める（チャットにお知らせは流れない） |
| **更新**（同じ `id` でもう一度 [配布]） | 上書きになる。サーバーが配信するのは常に1つの版。全員のクライアントで読み込み直す |
| **削除** | 全員のクライアントから外れる。セッションとカードは残る（同じ `id` で配布し直せば、また開ける） |
| **オン / オフ**（トグル） | **自分の端末でだけ**切り替える（その端末に保存）。配布されたプラグインは既定でオン |

- 配布・更新・削除は誰でもできます。最後に配布・更新した人は一覧の情報（`updated_by`）に残ります
- 開発用フォルダに、配布済みと同じ `id` のプラグインがあれば、自分の端末では開発中のほうが動きます。配布した版を直すときは、そのまま開発用フォルダで直して [配布] すれば更新になります
- 壊れたプラグインが配られても、各自がトグルでオフにできます

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
