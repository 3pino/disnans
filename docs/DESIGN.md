# デザインガイド（他のアプリへの流用用）

- アイコンは [Lucide](https://lucide.dev/)（線幅 2、丸い端。`stroke-linecap/linejoin: round`）
- 文言は日本語、`<html lang="ja">`

## 目次

1. [デザインの方針](#デザインの方針)
2. [最小の持ち出し手順](#最小の持ち出し手順)
3. [カラートークン](#カラートークン)
4. [テーマ切り替え](#テーマ切り替え)
5. [タイポグラフィ・形・影・余白](#タイポグラフィ形影余白)
6. [ベース設定（リセット）](#ベース設定リセット)
7. [部品カタログ](#部品カタログ)
8. [レイアウト](#レイアウト)
9. [チャット固有の見た目](#チャット固有の見た目)
10. [モーション・アクセシビリティ・タッチ](#モーションアクセシビリティタッチ)
11. [流用時のチェックリスト](#流用時のチェックリスト)

---

## デザインの方針

- **落ち着いた単色の青灰色。** 中立色はすべて `oklch(L 0.015 248)`（色相 248・彩度 0.015 の固定）で、**明度 L だけを変える**。
- **色は意味のあるものだけ。** アクセント（青）・メンション（黄土）・危険（赤）・成功（緑）・警告（黄）の 5 色のみ。
- **「青く光らせない」。** フォーカスは枠と背景を少し明るくするだけ、キーボードの輪郭線も中立色。アクセントは選択中・主ボタン・トグル ON など「状態」に使う。
- **カードで囲わない。** 設定は区切り線 + 小見出しだけ。余計な枠・影を使わず、影はポップアップ（メニュー・モーダル・トースト）だけ。
- **ライト／ダーク両対応。** どちらも同じトークン名で、値だけ入れ替える。
- 半透明の色は `color-mix(in oklch, …)` で派生させる（色を増やさない）。

## 最小の持ち出し手順

1. `app/src/styles/` の 3 ファイルをコピーして、この順に読み込む（`app/src/app.css` がその入り口の例）。
   | ファイル | 中身 | 流用先での扱い |
   | --- | --- | --- |
   | `tokens.css` | 色・文字サイズ・余白・角丸・影などのトークン（ライト／ダーク） | **アプリごとに値を調整する場所** |
   | `base.css` | リセット、`body`、スクロール・タッチの方針、フォーカスの輪郭、`prefers-reduced-motion` | そのまま |
   | `components.css` | `.btn`・`.toggle`・`.menu`・`.modal` などの部品 | そのまま（足すときは同じ命名で） |
   ```css
   @import './styles/tokens.css';
   @import './styles/base.css';
   @import './styles/components.css';
   ```
   `components.css` は `tokens.css` のトークンだけに依存している（直書きの色はない）。`app.css` に残っている検索ヒット強調（`::highlight`）は disnans 本体だけのものなので不要。
2. `<meta name="color-scheme" content="light dark" />` と `viewport` を入れる:
   ```html
   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
   <meta name="color-scheme" content="light dark" />
   ```
   （disnans はモバイルのピンチ拡大を止めるため `maximum-scale=1, user-scalable=no, interactive-widget=resizes-content` も付けている。流用先で拡大を許すなら不要）
3. アイコンに Lucide を入れる。
4. アプリの色味を変えたいときは、トークンの **色相 `248`** を一括置換するだけで全体が変わる（例: 緑系なら `150`）。

ブラウザ要件: `oklch()` と `color-mix(in oklch, …)`（Chrome 111+ / Safari 16.4+ / Firefox 113+）。

## カラートークン

### ライト（`:root`）／ダーク（下の値）

| トークン | ライト | ダーク | 用途 |
| --- | --- | --- | --- |
| `--bg` | `oklch(0.97 0.015 248)` | `oklch(0.17 0.015 248)` | 画面の地。入力欄の背景にも使う |
| `--surface` | `oklch(0.94 …)` | `oklch(0.21 …)` | ナビ・メニュー・モーダル・カードなど、一段浮いた面 |
| `--surface-2` | `oklch(0.9 …)` | `oklch(0.26 …)` | もう一段上。ボタンの地、ホバー・押下 |
| `--border` | `oklch(0.84 …)` | `oklch(0.32 …)` | 枠・区切り線・スライダーのトラック |
| `--border-hover` | `oklch(0.76 …)` | `oklch(0.44 …)` | ホバー時の枠（明るい地では濃く、暗い地では明るく） |
| `--border-focus` | `oklch(0.92 0.012 248)` | `oklch(0.43 …)` | 入力欄フォーカス時の枠 |
| `--field-focus-bg` | `oklch(0.97 0.012 248)` | `oklch(0.245 …)` | 入力欄フォーカス時の背景 |
| `--ring` | `oklch(0.45 …)` | `oklch(0.84 …)` | キーボードフォーカスの輪郭（`:focus-visible`） |
| `--text` | `oklch(0.22 …)` | `oklch(0.93 …)` | 本文 |
| `--text-muted` | `oklch(0.48 …)` | `oklch(0.7 …)` | 補足・アイコン・非選択 |

（`…` は `0.015 248`）

### 意味色

| トークン | ライト | ダーク | 用途 |
| --- | --- | --- | --- |
| `--accent` | `oklch(0.45 0.11 248)` | `oklch(0.74 0.13 248)` | 主ボタン・選択中・リンク・トグル ON |
| `--mention` | `oklch(0.45 0.09 75)` | `oklch(0.74 0.12 75)` | 自分宛て・検索ヒットの強調 |
| `--danger` | `oklch(0.45 0.15 25)` | `oklch(0.74 0.15 25)` | 削除・エラー・未読の点 |
| `--success` | `oklch(0.45 0.1 155)` | `oklch(0.74 0.12 155)` | 成功 |
| `--warning` | `oklch(0.45 0.09 85)` | `oklch(0.74 0.13 85)` | 注意 |

意味色は **ライトでは L=0.45（濃く）、ダークでは L=0.74（明るく）** が決まり。文字色としても背景としても使える明度にしてある。

### 派生（ライト・ダーク共通の式）

```css
--on-accent:    var(--bg);                                               /* 意味色の地に載せる文字 */
--accent-soft:  color-mix(in oklch, var(--accent)  14%, transparent);   /* 選択・強調の薄い地 */
--mention-soft: color-mix(in oklch, var(--mention) 16%, transparent);
--danger-soft:  color-mix(in oklch, var(--danger)  14%, transparent);
--hover:        color-mix(in oklch, var(--surface-2) 60%, transparent); /* ghost のホバー */
```

### その他

| トークン | 値 |
| --- | --- |
| `--shadow`（ライト） | `0 8px 28px oklch(0.22 0.015 248 / 0.16), 0 1px 3px oklch(0.22 0.015 248 / 0.1)` |
| `--shadow`（ダーク） | `0 10px 32px oklch(0.05 0.01 248 / 0.6), 0 1px 3px oklch(0.05 0.01 248 / 0.45)` |
| `--avatar-l` | ライト `0.45` / ダーク `0.74`（イニシャルアバターの明度） |
| `--scrim` / `--scrim-strong` | モーダル・ボトムシートの幕 `oklch(0.08 0.01 248 / 0.5)` / 画像ビューアの幕 `oklch(0.1 0.01 248 / 0.92)`（ライト・ダーク共通） |
| `--on-scrim` / `--on-scrim-soft` | 幕の上の文字 / ボタンの背景 |
| `--shadow-sm` | トグル・スライダーのつまみの影 |
| `--shadow-media` | 画像ビューアの画像の影 |
| `--mark` | 本文中のハイライト（黄色の半透明） |

### イニシャルアバター

画像がないユーザーは、ID の文字列から色相をハッシュで決める。

```css
background: oklch(var(--avatar-l) 0.08 var(--h));   /* --h は 0–360 */
color: var(--bg);
font-weight: 700;
font-size: round(サイズ × 0.42);
border-radius: 50%;
```

```ts
// ID → 色相（0–359）
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}
```

## テーマ切り替え

- 既定はシステム設定に追従（`@media (prefers-color-scheme: dark)` 内で `:root:not([data-theme='light'])` に値を入れる）。
- 明示的に選ばせるときは `<html data-theme="light|dark">` を付ける（`system` のときは属性を外す）。
- ダークの値は **2 か所に同じものを書く**（`@media` 内と `:root[data-theme='dark']`）。トークンを足したら両方に足すこと。
- `color-scheme: light | dark` も一緒に切り替える（スクロールバー・フォーム部品の色が追従する）。

利用者向けにトークンを上書きするカスタムテーマの仕組みは [`THEMES.md`](THEMES.md)。

## タイポグラフィ・形・影・余白

すべてトークン（`:root`、ライト・ダーク共通）。部品の CSS は直書きの px ではなく、これらを使う。
スケールに無い値（1px・3px・5px・14px・20px・32px など）だけは例外的に直書きしている。

```css
/* フォント。Web フォントは使わない（OS 標準） */
--font:  system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN',
         'Noto Sans JP', 'Yu Gothic UI', Meiryo, sans-serif;
--serif: ui-serif, 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', 'Noto Serif', Georgia, serif;
--mono:  ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'Noto Sans Mono', Menlo, Consolas, monospace;
```

`--serif` は disnans 本体では使っていない（流用先で必要になったとき用）。

| 種別 | トークン |
| --- | --- |
| 文字サイズ | `--fs-xs` 10（バッジ・ナビのラベル）/ `--fs-sm` 12（小見出し・補足・説明文）/ `--fs-base` 14（設定の行・トースト）/ `--fs-body` 15（本文）/ `--fs-lg` 16（モーダルのタイトルなど）/ `--fs-xl` 20（大見出し）/ `--fs-2xl` 24 |
| 太さ | `--fw-medium` 500 / `--fw-semibold` 600 / `--fw-bold` 700 |
| 行の高さ | `--lh-tight` 1.4 / `--lh-body` 1.55（本文） |
| 余白 | `--space-1` 2 / `-2` 4 / `-3` 6 / `-4` 8 / `-5` 10 / `-6` 12 / `-7` 16 / `-8` 24（px。gap・padding・margin 用） |
| 角丸 | `--radius-xs` 4 / `--radius-sm` 6（ボタン・入力欄）/ `--radius` 10（メニュー・カード）/ `--radius-lg` 14（モーダル・入力カード）/ `--radius-xl` 16（吹き出し）/ `--radius-pill` 999。丸（アバター・バッジ）は `50%` |

主な使い分け: 本文 `--fs-body` + `--lh-body`、設定の行 `--fs-base`（説明文 `--fs-sm`）、小見出し `--fs-sm` + `--fw-bold`（セクション見出しは字間 0.06em）、キー表示 `--mono` + `--fs-sm`。

高さの基準（直書き）: ボタン 36px / 入力欄 40px / アイコンボタン 34px / トグル 38×22 / セグメント内ボタン 32px。画面端の左右余白は `--space-7`（16px）。

**タイポグラフィを変えたいとき**は、トークンの値を変えるだけでよい（例: 本文を 16px にするなら `--fs-body: 16px`）。

## ベース設定（リセット）

`styles/base.css` に入っているもの。流用時もそのまま入れる。

- `box-sizing: border-box`（全要素）
- `html, body`: `height: 100%; overflow: hidden; overscroll-behavior: none`（画面全体はスクロールさせず、`.scroll` の領域だけが動く）
- `#app`: `height: var(--app-height, 100dvh)`（モバイルでキーボードが出たときに JS で `--app-height` を `visualViewport.height` に合わせている。不要なら `100dvh` のみ）
- `button, input, textarea, select { font: inherit; color: inherit }`
- `a { color: var(--accent) }`
- `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`
- `::selection`: アクセント 35%
- ボタン・ナビ・見出し・ラベルなどは `user-select: none; -webkit-touch-callout: none`（本文だけ選択できる）
- `-webkit-tap-highlight-color: transparent`

## 部品カタログ

クラス名の規約: 部品 `.part`、中身 `.part-child`、状態 `.part-state`（例 `.toggle-on`）。位置や大きさの調整は使う側が別クラスで行う。

| 部品 | クラス | 見た目の要点 |
| --- | --- | --- |
| アイコン | `.icon` | `flex: none`（縮まない）。Lucide 24px 基準、使う場所で 14–20px |
| アイコンボタン | `.icon-btn`（`.active`） | 34px 角・`--radius-sm`・背景なし・`--text-muted`。ホバーで `--hover` 地 + `--text`。`.active` は `--accent` + `--accent-soft` 地。disabled は opacity .45 |
| ボタン | `.btn`（`.primary` `.danger` `.ghost` `.btn-icon-only`） | 高さ 36px・横 14px・枠 1px `--border`・地 `--surface-2`・font-weight 500。`.primary` は `--accent` 地 + `--on-accent` 文字、`.danger` は `--danger` 地。ホバーは `brightness(1.06)`（通常ボタンは枠が `--text-muted` に）。`.ghost` は背景も枠もなく、ホバー・フォーカスで `--hover`、押下で `--surface-2`。disabled は opacity .5 |
| 入力欄 | `.input` | 高さ 40px・`--bg` 地・枠 `--border`・`--radius-sm`・`outline: none`。フォーカスで枠 `--border-focus` + 地 `--field-focus-bg`（青くしない） |
| 小見出し | `.field-label` | 入力欄の上に置く 12px/700 の `--text-muted` |
| トグル | `.toggle`（`.toggle-on`） | 38×22・角丸 11px。OFF は `--border` 地、ON は `--accent` 地。つまみは 16px の `--bg` 色の丸で、ON で 16px 右へ（0.12s） |
| スライダー | `.slider` / `-input` / `-value` | トラック 4px（`--border`）、つまみ 16px の `--accent` 丸。値は 12px・等幅数字・右寄せ |
| セグメント | `.segmented` / `-option`（`-selected`） | 地 `--surface-2` の枠、内側 4px。選択中の項目は `--bg` 地 + `--text`、他は `--text-muted`。高さ 32px・12px/600 |
| タブバー | `.nav-bar` / `-item`（`-selected`） | 下タブ: 上線 1px、地 `--surface`、アイコン + 10px ラベルを等分。選択は `--accent`。`.nav-bar-side` で幅 76px の左縦並び（右線 1px） |
| バッジ | `.badge` | 高さ 18px・min-width 18px・丸・`--accent` 地・10px/700 |
| 未読の点 | `.nav-bar-item-alert` | 9px の `--danger` 丸 + `0 0 0 2px var(--surface)` の縁取り |
| キー表示 | `.kbd` | 枠 1px（下だけ 2px）・`--surface-2` 地・等幅 12px |
| 区切り線 | `.divider` | `border-top: 1px solid var(--border)` |
| 設定セクション | `.setting-section` | 上下 18px。前にセクションがあるときだけ上端に区切り線。見出し 12px/700/`--text-muted`/字間 0.06em。中身は 10px 間隔 |
| 設定の行 | `.setting-row` | 左に名前 + 説明、右に操作。14px、間隔 12px。`.setting-row-button` で行全体が ghost ボタン |
| 状態表示 | `.status-line`（`-muted` `-ok` `-accent` `-warn` `-error`） | アイコン + 14px/600 の 1 行。色は意味色 |
| メニュー | `.menu` / `.menu-item`（`-danger`） | `--surface` 地・枠 1px・`--radius`・`--shadow`・padding 4px・min-width 200px。項目は padding 8×10・`--radius-sm`・間隔 10px、ホバー/押下で `--surface-2`。z-index 30（背後に透明な `.menu-backdrop` 29） |
| 補完候補 | `.suggest-list` / `-item`（`-selected`） | メニューと同じ面。選択中は `--accent-soft` 地。タイトル 600、詳細は 12px `--text-muted` で省略表示 |
| モーダル | `.modal-scrim` / `.modal` | 幕は `--scrim`。本体は幅 `min(420px, 100vw-32px)`・padding 20px・角丸 14px・`--surface`・枠 1px・`--shadow`・中央配置。出現は 0.15s のフェード + わずかなせり上がり。ボタンは右寄せ・間隔 8px（`.modal-actions`）。z-index 80/81 |
| トースト | `.toast` | 画面上部中央（幅 min(440px, 100vw-24px)）、`--surface`・枠・`--radius`・`--shadow`・14px。エラーは左に 3px の `--danger` 帯だけ。z-index 90 |
| カード | `.message-card` | `--surface` 地・枠 1px・`--radius-sm`・padding 8×12。押せるものはホバーで `--border-hover`。使えないものは破線枠 |
| スクロール領域 | `.scroll` | `overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent` |
| 回転 | `.spin` | 0.9s linear 無限 |

z-index の目安: メニュー 29–30 / パネル（モバイル全面）30 / モーダル 80–81 / トースト 90。

## レイアウト

- 幅の境目は **767px**（`max-width: 767px` がモバイル）。
- **広い画面**: 左にナビ（76px、縦並び）| メイン（`minmax(0,1fr)`）| 右パネル（任意。`minmax(320px, 420px)`、左に 1px の枠）の 3 列グリッド。
- **モバイル**: 縦積み。ナビは下のタブバー、パネルは全画面（`position: fixed; inset: 0`、右から 0.18s でスライドイン）。
- 変数: `--nav-side-w: 76px`、`--panel-w: 420px`。
- セーフエリア: 上は `.top-bar`（`padding-top: calc(env(safe-area-inset-top) + 8px)`）、下は `max(14px, env(safe-area-inset-bottom))`。`viewport-fit=cover` が前提。
- 画面の区切りは**面の色差 + 1px の `--border`**。影は使わない。

## チャット固有の見た目

（チャット以外のアプリでは不要。参考）

- 入力欄（コンポーザー）: 外側 padding `0 16px 14px`。内側は `--surface` 地・枠 1px・角丸 14px・padding 4×6 の横並び（＋ボタン / 入力 / 送信）。
- 発言: 左右 padding 16px、前の発言との間隔 6px（同じ人の連続は 0）。アバター 36px。
- 吹き出し: 角丸 16px、padding 7×12。自分は `color-mix(in oklch, var(--accent) 16%, var(--surface))` 地で右寄せ、他人は `--surface` 系。
- 自分宛て（メンション）: `--mention-soft` 地 + 左に 2px の `--mention` 帯（`inset 2px 0 0`）。
- 編集中: `--accent-soft` 地。送信中は opacity .6。
- 返信先へ飛んだとき: `--accent-soft` を 1.8s かけて消える点滅。
- 検索ヒット: `::highlight(search-hit)` = `--mention-soft` 地 + `--mention` の下線。
- アプリアイコン: Lucide の `message-circle` を `#5b8fc7`（線のみ・幅 2）で描いたもの（`app/public/icon.svg`）。

## モーション・アクセシビリティ・タッチ

- 動きは短く控えめ: 0.12s（トグル）・0.15s（モーダル）・0.18s（スライド・トースト）。イージングは `ease-out`。
- `prefers-reduced-motion: reduce` では全アニメーション・トランジションを 0.01ms にする（`base.css` に入っている）。
- ホバー表現は `@media (hover: hover)` の中だけ（タッチ操作のデバイスで押したあと明るいまま残るのを防ぐ）。`.menu-item`・`.icon-btn` が該当。
- アイコンだけのボタンには必ず `aria-label`。飾りのアイコンは `aria-hidden`。
- キーボードフォーカスは `:focus-visible` の 2px `--ring` 輪郭。
- 色だけに頼らない（状態はアイコン・文言・形も併用）。
- タッチ: ピンチ拡大を止める `touch-action: pan-x pan-y`、ボタン類のテキスト選択・長押しコールアウトを止める。

## 流用時のチェックリスト

- [ ] `styles/` の 3 ファイルを取り込み、`color-scheme` メタを入れた
- [ ] ダークのトークンを `@media` 内と `[data-theme='dark']` の両方で更新した
- [ ] 色は必ずトークンから使っている（直書きの色がない）
- [ ] 新しい部品も `.part` / `.part-child` / `.part-state` の命名にした
- [ ] 角丸は 6 / 10 / 14 px のどれかに合わせた
- [ ] ホバーは `@media (hover: hover)` に入れた
- [ ] アイコンだけのボタンに `aria-label` を付けた
- [ ] 色味を変えるなら色相 `248` を一括置換した
- [ ] ライト・ダーク両方の見た目を目視で確認した（**見た目の最終確認は人が行う**）
