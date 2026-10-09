# プラグインの UI 部品（disnans.ui）とアイコン

`disnans.ui` は、本体と**同じ見た目**の部品を DOM 要素として作る関数の集まりです。
見た目の正は本体のグローバルの CSS クラス（`app/src/app.css`）で、本体の Svelte の部品（`app/src/components/ui/`）と

作り方の全体は [PLUGINS.md](PLUGINS.md)、型は `packages/plugin-sdk/index.d.ts`（`Disnans.Ui`）を参照してください。

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
  - [ui.setting](#uisetting)
  - [ui.toast](#uitoast)
  - [ui.confirm](#uiconfirm)
- [CSS クラス](#css-クラス)

```js
const { ui } = disnans;
```

---

## アイコン

### アイコンの名前

アイコンを受け取るところ（`ui.icon`、`ui.button` の `icon`、`ComposerAction.icon`、`SlashCommand.icon`、`View.icon` など）は、
どこでも**アイコンの名前**（文字列）で指定します。名前は次の順に探します。

1. 本体の独自のアイコン: `disnans-logo`（アプリのロゴ。Lucide のアイコンと並べて使えるように作ってあります）
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
- 枠のない小さなアイコンのボタンは、`<button class="icon-btn">` に `ui.icon(...)` を入れて作れます

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

タブのバー（`.nav-bar`）です。本体の下のナビゲーション（Chat / Threads / Settings）と同じ見た目で、view の中にタブを作るときに使います。
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
ボタンの文字は `okLabel`（既定は「OK」）と `ngLabel`（取り消すほう。既定は「キャンセル」）で変えられます。

```js
const ok = await ui.confirm({ title: 'やり直しますか？', okLabel: 'やり直す', ngLabel: 'やめる', danger: true });
```

---

## CSS クラス

`disnans.ui` を使わずに、同じクラスを付けた要素を自分で作っても同じ見た目になります。
クラス名の決まりは、部品が `.part`、部品の中が `.part-child`、状態が `.part-state` です。

| クラス | 内容 | 作る関数 |
|---|---|---|
| `.icon` | アイコンの `<svg>` | `ui.icon` |
| `.btn`（`.primary` / `.danger` / `.ghost` / `.btn-icon-only`） | ボタン。`.ghost` は枠のないボタン、`.btn-icon-only` はアイコンだけの正方形 | `ui.button` |
| `.icon-btn`（`.active`） | 枠のない、アイコンだけの小さなボタン | — |
| `.toggle` / `.toggle-thumb`（`.toggle-on`） | トグルスイッチ | `ui.toggle` |
| `.input` | 1行の入力欄 | `ui.input` |
| `.segmented` / `.segmented-option`（`.segmented-option-selected`） | 横に並んだ選択肢 | `ui.segmented` |
| `.nav-bar` / `.nav-bar-item`（`.nav-bar-item-selected`） / `.nav-bar-item-icon` / `.nav-bar-item-badge` / `.nav-bar-item-label` | タブのバー | `ui.navbar` |
| `.divider` | 横の区切り線（`<hr>`） | `ui.divider` |
| `.setting-row` / `-icon` / `-info` / `-name` / `-description` / `-control` | 設定の1行 | `ui.setting` |
| `.status-line`（`-muted` / `-ok` / `-accent` / `-warn` / `-error`） | アイコン付きの1行の状態表示 | — |
| `.field-label` | 入力欄の上の小さな見出し | — |
| `.muted` | 控えめな文字 | — |
| `.badge` | 数字のバッジ | — |
| `.scroll` | 縦スクロールする領域 | — |

- 位置や余白など、使う場所だけの調整は、**プラグイン ID の接頭辞を付けた自分のクラス**で書きます（`.dice-view .btn { ... }` など）
- `.btn` などの本体のクラスそのものを書き換えないでください（全員の本体の見た目が変わります）
- 色は CSS 変数（`--accent` など。[PLUGINS.md の「見た目（CSS）」](PLUGINS.md#見た目css)）を使います
