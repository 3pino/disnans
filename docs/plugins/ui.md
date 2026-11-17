# プラグインの UI 部品（disnans.ui）とアイコン

`disnans.ui` は、本体と**同じ見た目**の部品を DOM 要素として作る関数の集まりです。
見た目の正は本体のグローバルの CSS クラス（`@3pino/design-system`（`components.css`））です。
ここで説明する部品は、本体の画面が使うのと**同じ Svelte の部品**（共有パッケージ [@3pino/ui-kit-web](https://github.com/3pino/ui-kit-web)）を本体が載せて、できた DOM の要素を渡すものなので、本体の部品と同じクラスを付けた同じ DOM になります。

作り方の全体は [プラグインの作り方](README.md)、型は `packages/plugin-sdk/index.d.ts`（`Disnans.Ui`）を参照してください。

## 目次

- [アイコン](#アイコン)
  - [アイコンの名前](#アイコンの名前)
  - [addIcon（独自のアイコン）](#addicon独自のアイコン)
  - [プラグインのアイコン（icon.svg / manifest.icon）](#プラグインのアイコンiconsvg--manifesticon)
- [部品](#部品)
  - [ui.icon](#uiicon)
  - [ui.button](#uibutton)
  - [ui.toggle](#uitoggle)
  - [ui.input](#uiinput)
  - [ui.segmented](#uisegmented)
  - [ui.navbar](#uinavbar)
  - [ui.divider](#uidivider)
  - [ui.iconButton](#uiiconbutton)
  - [ui.section](#uisection)
  - [ui.statusLine](#uistatusline)
  - [ui.slider](#uislider)
  - [ui.setting](#uisetting)
  - [ui.menu](#uimenu)
  - [ui.modal](#uimodal)
  - [ui.toast](#uitoast)
  - [ui.confirm](#uiconfirm)
  - [ui.onBack / ui.setImmersive](#uionback--uisetimmersive)
- [CSS クラス](#css-クラス)

```js
const { ui } = disnans;
```

---

## アイコン

### アイコンの名前

アイコンを受け取るところ（`ui.icon`、`ui.button` の `icon`、`ComposerAction.icon`、`SlashCommand.icon`、`View.icon` など）は、
どこでも**アイコンの名前**（文字列）で指定します。名前は次の順に探します。

1. 本体の独自のアイコン: `disnans-logo`（アプリのロゴ）
2. `addIcon` で登録したアイコン（どのプラグインが登録したものでも）
3. [Lucide](https://lucide.dev/icons) のアイコン（サイトに出ている名前。例: `dice-5`, `message-circle`, `settings`）

- Lucide のアイコンは、初めて使うときに読み込みます。読み込むまでの一瞬は空で、読み込めたら自動で描かれます
- 見つからない名前は空のアイコンになり、コンソールに警告が出ます

### addIcon（独自のアイコン）

```js
onload() {
  // 中身だけ（24x24 の viewBox。既定は fill="none" stroke="currentColor" stroke-width="2"）
  this.addIcon('dice-cup', '<path d="M5 4h14l-2 16H7z"/><path d="M8 9h8"/>');
  // <svg> まるごとでもよい（viewBox や fill などの属性も使う。width / height / class は使わない）
  this.addIcon('dice-pip', '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="4"/></svg>');

  this.addComposerAction({ id: 'roll', label: 'サイコロ', icon: 'dice-cup', run: () => {} });
}
```

- 名前はほかのプラグインとぶつからないように、**プラグイン ID を前に付けて**ください（`dice-cup` など）。同じ名前は後から登録したものが勝ちます。`disnans-logo` は上書きできません
- プラグインを外すと自動で消えます
- `<script>` やイベント属性（`onclick` など）は取り除かれます

### プラグインのアイコン（icon.svg / manifest.icon）

プラグイン自身のアイコンは、設定のプラグイン一覧、パネルの上部、カード、「＋」メニューや補完の既定のアイコンに出ます。次の順に決まります。

1. パッケージの `icon.svg`（任意。24×24、`stroke="currentColor"` 推奨。`addIcon` と同じ形で取り込みます）
2. `manifest.json` の `icon`（Lucide のアイコン名。例: `"icon": "dice-5"`）
3. どちらもなければ `puzzle`

---

## 部品

> **部品の寿命**: 部品が返す要素は、画面（document）に付けて使います。画面から外したまま **30 秒以上**（一度も付けないまま 5 分以上）置くと、本体はその部品の内部の仕組みを片付けます。そのあとも要素は残り、押したときのコールバックは呼ばれますが、見た目の切り替え（トグルのオン・オフの表示、セグメントの選択など）は止まります。付け替えて使い続けるときは、外さずに `hidden` で隠すか、作り直してください。
> メニュー・モーダルは、閉じる（`close()`）か、プラグインを外すと片付きます。

### ui.icon

```ts
ui.icon(name: IconName, opts?: { size?: number; class?: string; label?: string }): SVGSVGElement
```

アイコンの `<svg class="icon">` を作ります。`size` の既定は 24（px）。`label` を渡すと読み上げ用の名前（`role="img"`）、省くと飾り（`aria-hidden`）になります。

```js
const el = ui.icon('dice-5', { size: 18 });
titleEl.prepend(el);
```

### ui.button

```ts
ui.button(opts: {
  text?: string;          // ボタンの文字
  icon?: IconName;        // 文字の左のアイコン。text がなければアイコンだけのボタン
  label?: string;         // 読み上げ用の名前（アイコンだけのときは必須）
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  onClick?: () => void;
  disabled?: boolean;
}): HTMLButtonElement
```

`.btn` のボタンです。`text` と `icon` の少なくとも一方が必要です。

```js
ui.button({ text: '振る', variant: 'primary', onClick: () => this.roll() });  // 文字だけ
ui.button({ text: 'もう一度', icon: 'rotate-ccw', onClick: () => {} });        // アイコン + 文字
ui.button({ icon: 'send', label: '送信', variant: 'primary', onClick: () => {} }); // アイコンだけ（正方形の .btn-icon-only）
ui.button({ icon: 'settings', label: '設定', variant: 'ghost', onClick: () => {} }); // 枠のないボタン
```

- `variant: 'ghost'` は枠も背景もないボタンです。ホバー・フォーカス・押している間だけ背景に色が付きます
- `disabled` はあとから `el.disabled = true` でも変えられます
- 枠のない小さなアイコンのボタンは [`ui.iconButton`](#uiiconbutton) です

### ui.toggle

```ts
ui.toggle(opts: { value: boolean; onChange?: (value: boolean) => void; label?: string }): HTMLElement
```

トグルスイッチ（`<button role="switch" class="toggle">`）です。`label` は読み上げ用の名前で、見える名前は `ui.setting` などで横に出します。

```js
ui.toggle({ value: true, label: '音を鳴らす', onChange: (v) => {} });
```

### ui.input

```ts
ui.input(opts?: { value?: string; placeholder?: string; onChange?: (value: string) => void }): HTMLInputElement
```

1行の入力欄（`.input`）です。`onChange` は打つたびに呼ばれます。

```js
ui.input({ value: '', placeholder: '1d6', onChange: (v) => {} });
```

### ui.segmented

```ts
ui.segmented(opts: {
  options: { value: string; label: string; icon?: IconName }[];
  value: string;
  onChange?: (value: string) => void;
  label?: string; // 読み上げ用の名前
}): HTMLElement
```

横に並んだ選択肢から1つを選ぶボタン（`.segmented`）です。本体の設定のテーマの切り替えと同じ見た目です。
押すと見た目も切り替わります（`role="radiogroup"`）。

```js
ui.segmented({
  label: '面の数',
  value: '6',
  options: [
    { value: '6', label: 'd6', icon: 'dice-6' },
    { value: '20', label: 'd20' },
  ],
  onChange: (v) => (this.sides = Number(v)),
});
```

### ui.navbar

```ts
ui.navbar(opts: {
  items: { id: string; label: string; icon: IconName; badge?: number | string | null }[];
  selected?: string;
  onSelect?: (id: string) => void;
  label?: string; // 読み上げ用の名前
}): HTMLElement
```

タブのバー（`.nav-bar`）です。本体のナビゲーション（Chat / Settings など）と同じ見た目で、view の中にタブを作るときに使います。
押すと選択中の見た目も切り替わります。`badge` は 0・空文字列・`null` なら出ません。

```js
onOpen(containerEl) {
  const body = document.createElement('div');
  const show = (id) => body.replaceChildren(id === 'log' ? this.renderLog() : this.renderBoard());
  const nav = disnans.ui.navbar({
    label: 'ダイスのタブ',
    selected: 'board',
    items: [
      { id: 'board', label: '盤面', icon: 'dice-5' },
      { id: 'log', label: '履歴', icon: 'history', badge: this.unread },
    ],
    onSelect: show,
  });
  containerEl.append(body, nav);
  show('board');
}
```

- バッジの数などを変えたいときは、`ui.navbar` で作り直して置き換えます
- 上端に線（`border-top`）が付きます。上に置くときなどは、自分のクラスで調整してください

### ui.divider

```ts
ui.divider(): HTMLHRElement
```

横の区切り線（`<hr class="divider">`）です。

### ui.setting

```ts
ui.setting(containerEl: HTMLElement, opts: {
  name: string;
  description?: string;
  icon?: IconName;        // 名前の左のアイコン
  control?: HTMLElement;  // 右側の操作（トグル・入力欄・ボタンなど）
}): HTMLElement
```

設定の1行（`.setting-row`）を `containerEl` の末尾に足して返します。設定タブ（`addSettingTab`）で使います。

```js
ui.setting(containerEl, {
  name: '既定のサイコロ',
  description: '/dice だけで送ったときの個数と面の数',
  icon: 'dice-5',
  control: ui.input({ value: this.settings.defaultSpec, onChange: (v) => {} }),
});
```

### ui.iconButton

（API v18）

```ts
ui.iconButton(opts: {
  label: string;             // 読み上げ用の名前（必須）
  icon?: IconName;           // アイコン
  iconSize?: number;         // アイコンの大きさ（px）。既定は 18
  active?: boolean;          // 押されている状態（.active）
  disabled?: boolean;
  class?: string;
  children?: string | Node | (string | Node)[];   // アイコンのあとに足す中身
  onClick?: () => void;
}): HTMLButtonElement
```

枠のない、アイコンだけのボタン（`.icon-btn`）です。ツールバーの小さな操作に使います。`children` の文字列は文字として入ります（HTML としては読みません）。

```js
ui.iconButton({ icon: 'settings', label: '設定', onClick: () => this.openSettings() });
```

### ui.section

（API v18）

```ts
ui.section(opts: { title: string; class?: string; children?: string | Node | (string | Node)[] }): HTMLElement
```

設定のセクション（`<section class="setting-section">`。区切り線 + 見出し + 中身）です。`children` に `ui.setting` の行などを入れます。前にもセクションがあるときだけ区切り線が出ます。

### ui.statusLine

（API v18）

```ts
ui.statusLine(opts?: {
  kind?: 'default' | 'muted' | 'ok' | 'accent' | 'warn' | 'error';
  icon?: IconName;
  busy?: boolean;        // 回るアイコン（icon より優先）
  class?: string;
  children?: string | Node | (string | Node)[];
}): HTMLElement
```

アイコン付きの 1 行の状態表示（`<p class="status-line">`）です。`kind` で色が変わります。

```js
ui.statusLine({ kind: 'ok', icon: 'circle-check', children: '最新です' });
ui.statusLine({ busy: true, children: '読み込み中…' });
```

### ui.slider

（API v18）

```ts
ui.slider(opts: {
  label: string;                   // 読み上げ用の名前（必須。見える名前は ui.setting などで横に出す）
  value?: number;                  // 既定は 0
  min?: number;                    // 既定は 0
  max?: number;                    // 既定は 100
  step?: number;                   // 既定は 1
  format?: (value: number) => string;   // 右に出す値の書き方。例: (v) => v + '%'
  disabled?: boolean;
  class?: string;
  onInput?: (value: number) => void;    // 動かしている間
  onChange?: (value: number) => void;   // 離したとき
}): HTMLElement
```

範囲のスライダー（`.slider`。ネイティブの `<input type="range">` と、右に今の値）です。値の保存は、離したとき（`onChange`）にするとよいです。`format` が例外を投げても、数のまま出します。

```js
ui.setting(containerEl, {
  name: '音量',
  control: ui.slider({ label: '音量', value: 50, format: (v) => `${v}%`, onChange: (v) => this.save(v) }),
});
```

### ui.menu

（API v18）

```ts
ui.menu(opts: {
  anchor: HTMLElement;     // メニューを出す位置の基準（このボタンの下に開く）
  items: {
    text: string;
    icon?: IconName;
    danger?: boolean;      // 赤い項目
    disabled?: boolean;    // 押せない
    reason?: string;       // 押せない理由（disabled のとき、項目名の下に小さく出る）
    onClick?: () => void;
  }[];                     // 1 つ以上
  align?: 'start' | 'end'; // start（既定）は基準の左端、end は右端にそろえる
  label?: string;          // 読み上げ用の名前
  onClose?: () => void;    // 項目を選ばずに閉じたとき
}): { close(): void; readonly closed: boolean }
```

ポップアップのメニューを `anchor` の下に開きます。

```js
const btn = ui.iconButton({ icon: 'ellipsis', label: 'その他' });
btn.addEventListener('click', () => {
  ui.menu({
    anchor: btn,
    align: 'end',
    items: [
      { text: 'コピー', icon: 'copy', onClick: () => this.copy() },
      { text: '削除', icon: 'trash-2', danger: true, onClick: () => this.remove() },
    ],
  });
});
```

- 項目を選ぶと、**メニューを閉じてから** `onClick` を呼びます。`onClose` は呼びません
- 外側（透明な幕）を押す・戻る操作（Android の戻る・Alt+←）では、閉じて `onClose` を呼びます
- 戻り値の `close()` で閉じます（`onClose` は呼ばれません。何度呼んでもかまいません）
- 画面の下にはみ出すときは基準の上に、左右にはみ出すときは収まるようにずらして開きます
- 文字（`text`・`reason`・`label`）は文字として入ります（HTML としては読みません）
- プラグインを外す（無効にする・読み込み直す）と、開いたままのメニューは閉じます。ただし `disnans.ui` は本体に 1 つなので、持ち主は区別されず、その時に開いているメニュー・モーダルはすべて閉じます。自分のものだけを確実に閉じたいときは `this.register(menu.close)` も付けてください
- 項目だけを作る関数（`menuItem`）は出していません。項目はメニューの `items` で渡します

### ui.modal

（API v18）

```ts
ui.modal(opts: {
  title: string;
  width?: number;                       // px。既定は 420（画面が狭いときは収まる）
  children?: string | Node | (string | Node)[];   // 本文
  actions?: ButtonOptions[];            // 下に並べるボタン（ui.button と同じオプション）
  onClose?: () => void;                 // Esc・外側・戻る操作で閉じたあと
}): { close(): void; readonly closed: boolean }
```

モーダルのダイアログを開きます。開いたとき最初の入力欄・ボタンにフォーカスし、閉じたら元のフォーカスに戻します。

```js
const name = ui.input({ placeholder: '名前' });
const dlg = ui.modal({
  title: '名前を付ける',
  children: name,
  actions: [
    { text: 'キャンセル', onClick: () => dlg.close() },
    { text: '保存', variant: 'primary', onClick: () => { this.save(name.value); dlg.close(); } },
  ],
});
```

- `actions` のボタンを押しても、**自動では閉じません**（処理の中で `close()` を呼びます）
- Esc・外側（幕）の押下・戻る操作では、閉じて `onClose` を呼びます。`close()` では `onClose` は呼ばれません（何度呼んでもかまいません）
- 文字（`title`・`children` の文字列）は文字として入ります（HTML としては読みません）
- プラグインを外すと、開いたままのモーダルは閉じます（持ち主の区別がない点は `ui.menu` と同じ。`this.register(dlg.close)` で確実に）
- 確認だけなら [`ui.confirm`](#uiconfirm) を使ってください
- 全画面の見出しの行（`PanelBar`）と、入力欄の補完候補（`SuggestList`）は出していません。前者は本体のパネルの外枠が持ち、後者は入力欄の位置・キー操作を使う側が組む必要があり、プラグインの画面では使い道が少ないためです

### ui.toast

```ts
ui.toast(text: string, kind?: 'info' | 'error'): void
```

画面の下に短いお知らせを出します。入力の誤りなどは `'error'` で知らせます。

### ui.confirm

```ts
ui.confirm(opts: { title: string; body?: string; okLabel?: string; ngLabel?: string; danger?: boolean }): Promise<boolean>
```

確認ダイアログを出し、OK なら `true` を返します。`danger` で OK ボタンが赤になります。
ボタンの文字は `okLabel`（既定は「OK」）と `ngLabel`（既定は「キャンセル」）で変えられます。

```js
const ok = await ui.confirm({ title: 'やり直しますか？', okLabel: 'やり直す', ngLabel: 'やめる', danger: true });
```

### ui.onBack / ui.setImmersive

```ts
ui.onBack(handler: () => void): () => void
ui.setImmersive(on: boolean): Promise<boolean>
```

（API v9）`onBack` は、戻る操作（Android の戻るボタン・ジェスチャー、PC の Alt+←）で閉じる層を足します。戻る操作のたびに、本体のパネルなどより先に、足した新しいものから 1 つずつ `handler` が呼ばれます。戻り値の関数で外します（`this.register` に渡して片付けます）。

`setImmersive` は、Android でステータスバーとナビゲーションバーを隠す没入モードにします（端からスワイプすると一時的に出ます）。Android の WebView には Fullscreen API が無いので、全画面の表示に使います。ネイティブで切り替えたら `true`、それ以外の環境では何もせず `false` なので、`requestFullscreen` を使ってください。

---

## CSS クラス

`disnans.ui` を使わずに、同じクラスを付けた要素を自分で作っても同じ見た目になります。
クラス名の決まりは、部品が `.part`、部品の中が `.part-child`、状態が `.part-state` です。

| クラス | 内容 | 作る関数 |
|---|---|---|
| `.icon` | アイコンの `<svg>` | `ui.icon` |
| `.btn`（`.primary` / `.danger` / `.ghost` / `.btn-icon-only`） | ボタン。`.ghost` は枠のないボタン、`.btn-icon-only` はアイコンだけの正方形 | `ui.button` |
| `.icon-btn`（`.active`） | 枠のない、アイコンだけの小さなボタン | `ui.iconButton` |
| `.toggle` / `.toggle-thumb`（`.toggle-on`） | トグルスイッチ | `ui.toggle` |
| `.input` | 1行の入力欄 | `ui.input` |
| `.segmented` / `.segmented-option`（`.segmented-option-selected`） | 横に並んだ選択肢 | `ui.segmented` |
| `.nav-bar` / `.nav-bar-item`（`.nav-bar-item-selected`） / `.nav-bar-item-icon` / `.nav-bar-item-badge` / `.nav-bar-item-label` | タブのバー | `ui.navbar` |
| `.divider` | 横の区切り線（`<hr>`） | `ui.divider` |
| `.setting-row` / `-icon` / `-info` / `-name` / `-description` / `-control` | 設定の1行 | `ui.setting` |
| `.status-line`（`-muted` / `-ok` / `-accent` / `-warn` / `-error`） | アイコン付きの1行の状態表示 | `ui.statusLine` |
| `.setting-section` / `-divider` / `-title` | 設定のセクション | `ui.section` |
| `.slider` / `-input` / `-value` | 範囲のスライダー | `ui.slider` |
| `.menu` / `.menu-item`（`.menu-item-danger`） / `.menu-backdrop` | ポップアップのメニュー | `ui.menu` |
| `.modal` / `.modal-scrim` / `.modal-title` / `.modal-actions` | モーダルのダイアログ | `ui.modal` |
| `.field-label` | 入力欄の上の小さな見出し | — |
| `.muted` | 控えめな文字 | — |
| `.badge` | 数字のバッジ | — |
| `.scroll` | 縦スクロールする領域 | — |

- 位置や余白など、使う場所だけの調整は、**プラグイン ID の接頭辞を付けた自分のクラス**で書きます（`.dice-view .btn { ... }` など）
- `.btn` などの本体のクラスそのものを書き換えないでください（全員の本体の見た目が変わります）
- 色は CSS 変数（`--accent` など。[「見た目（CSS）」](styles.md#見た目css)）を使います

## API 19 の部品と口

- `ui.navItem({ id, label, icon, view?, onOpen?, badge? })`: ナビバーの項目。**登録すると、ナビの末尾に自動で出ます**（利用者の並べ替えには入りません。コマンドではないので、パレットには出ません）。`view` を渡すと選んだときにその view をパネルに開き、`onOpen` は選んだときに呼ばれます（両方でもかまいません）。選んでいる間は、その view を開いているときにその項目が選ばれます。戻り値は `{ setBadge(n), close() }`。`badge` は右上の数字（0・空・null は出ません）。`id` は本体の中で一意です。`<プラグインID>:<名前>` の形を使ってください（プラグインごとの名前空間はまだありません）。プラグインを外すときは `this.register(h.close)` で外すと安全です
- `ui.openLightbox(item, gallery?)`: 拡大表示（画像・PDF）。`item` は `{ src, alt, downloadUrl?, kind? }`（`kind` は `'image'`（既定）か `'pdf'`）。`gallery` は呼ぶたびに今の一覧を返す関数（前後で移動できる）
- `ui.renderPdfThumb(el, source, { key? })`: PDF の 1 ページ目のサムネイルを `el` の中に描きます（本体の部品）。戻り値の関数で外します。`source` は URL（`this.files.url` など）
- `ui.openSearch(query?)`: チャットの検索を開きます。`query` を渡すと、その語で検索します
- `ui.toast(text, kind?, action?)`: トーストに操作を付けられます。`action` は `{ label, run }`（例: 「元に戻す」）
- `ui.clipboard.copyText(text)` / `readText()` / `readImage()` / `peek()` / `textName()`: クリップボード。ユーザーの操作（ボタンを押したなど）の中から呼んでください。`readImage()` は Linux の WebView で貼り付けから取れないときの経路も先に試します（呼ぶ側は気にしなくてよい）。`peek()` は中身の種類（`{ text, image }`、分からなければ `'unknown'`）、`textName()` は貼り付けたものの保存名
- `ui.download({ url, name })`: 本体のサーバーの URL（`files.url(entry)` など）を保存します。Tauri（デスクトップ・Android）では直接保存してトーストを出し、ブラウザーでは `<a download>` です。`url` は `/api/files/` か `/api/shared/` のものだけ直接保存されます（それ以外は既定の動き）
- `ui.interceptDownload(ev, { url, name })`: リンクの押し（`MouseEvent`）を、`ui.download` の保存に差し替えます。差し替えたら `true`。右クリックや修飾キー付きの押しは差し替えません（既定の動き）
- `ui.saveBlob(blob, name)`: **サーバーの URL ではない**データ（作ったファイルなど）の保存。**ブラウザーのみ**（`<a download>`）。Tauri では `unsupported`（Blob を保存する本体の口がまだありません）
- `ui.pickSharedFiles({ multiple?, folderOnly? })`: 共有フォルダの一覧から選ぶ画面を開きます。選んだ項目の配列を返し、取り消しは `null`。`multiple` は複数、`folderOnly` はフォルダだけ
- `ui.osDrop`: OS からのドロップの口（explorer-kit の `osDrop` と同じ形）。`listenNative(handler)` / `listen(handler)` は解除関数を返します。`entries(id)`（中身の読み出し）・`release(id)`・`rootsOf(dt)`・`entriesFromRoots(roots)` を使えます。**プラグインの view を出している間だけ listen し、閉じるときに解除してください**（`this.register` で登録すると、外すときに自動で解除されます）。権限は要りません
- `ui.dragType`: チャットから共有フォルダへのドラッグの型（本体の値と同じ）

使えない環境で呼ぶと、`disnans.PluginError` の `code` が `unsupported` になります。非同期の口は、失敗を Promise の拒否で返します。
