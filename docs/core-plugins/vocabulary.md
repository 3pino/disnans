# 木の部品の語彙・イベント・追加 API

状態: **設計案(未実装)**。名前・props は仮。確定ではない。GUI / TUI の対応のうち、GUI の部品名は `app/src/components/ui/`、TUI の部品名は [DESIGN.md](../DESIGN.md) の「部品の対応」にある実在のもの。

## 部品の語彙(案)

| ノード | 主な props | 主なイベント | GUI(現状の部品) | TUI(現状の部品) |
|---|---|---|---|---|
| `Stack` | `dir: 'v'\|'h'`、`gap`、`children`、`wrap` | — | 要素の並び(CSS) | Row / Section の並び |
| `Text` | `text`、`tone: 'normal'\|'muted'\|'danger'\|…`、`strong` | — | 文字 | 文字 |
| `Icon` | `name` | — | Icon(Lucide・`addIcon`) | Glyph(Nerd Font) |
| `Image` | `src`、`alt`、`size` | `press` | `<img>` | 画像の描画層、なければグリフ |
| `Button` | `label`、`icon`、`variant`、`disabled` | `press` | Button / IconButton | Button |
| `Input` | `value`、`placeholder`、`multiline`、`error` | `change`、`submit` | TextInput | TextField |
| `Toggle` | `checked`、`label` | `change` | Toggle | Toggle |
| `Choice` | `options`、`value`、`style: 'segmented'\|'select'` | `change` | SegmentedButton / select | Choice |
| `Slider` | `min/max/step/value` | `change` | Slider | Stepper |
| `List` | `items`(`key`・行の木)、`selected`、`selectable`、`reorderable`、`empty` | `select`、`press`(行)、`context`、`reorder` | 行の並び / SortableList | List |
| `Menu` | `items`(`label`・`icon`・`action`・`checked`・`danger`)、`anchor` | `press`(項目) | Menu / MenuItem | Menu |
| `Dialog` | `title`、`children`、`actions`、`danger` | `close` | Modal / confirm | Dialog |
| `PanelBar` | `title`、`breadcrumbs`、`actions` | `press`(パンくず・操作) | PanelBar | 見出しの行 |
| `Tabs` | `items`、`selected` | `change` | NavBar | Tabs |
| `Divider` | — | — | Divider | Rule |
| `Status` | `text`、`kind`、`busy` | — | StatusLine / toast | StatusLine / Toast |
| `Setting` | `name`、`description`、`control`(部品) | `press`(行がボタンのとき) | SettingRow | Row |
| `Section` | `title`、`children` | — | Section | Section |
| `Slot` | `id`、`props` | (GUI が決める) | 本体/プラグインが描く | (TUI は出さないか代替) |

- どのノードにも `id`(アクションの宛先・フォーカス)、`show: { gui, tui }`、`gui`(GUI のヒント。TUI は無視)を付けられる。
- 行(`List.items[]`)の中身はノードの木(アイコン + 名前 + 補足の `Stack` など)。
- 戻る・閉じる: 画面全体に `onBack`(アクション)を宣言。Android の戻る・Alt+←・TUI の Esc がこれにバインドされる(現行の `navHistory` に画面を載せる)。

## イベントとアクション

- ノードのイベントに **アクション名** を結びつけ、値(`{ id, value, key? }`)を `update` に渡す。例: `Button { label: '新しいフォルダ', on: { press: 'mkdir' } }`。
- 画面全体のショートカット: `shortcuts: [{ action, default: 'Mod+N', label }]`。GUI は既存のホットキー、TUI はキー設定(`tui keys`)にバインドする(現行のコマンドと同じ登録)。
- 副作用(`update` の返す値): `files.*` の呼び出し、`navigate`(画面を開く・閉じる)、`toast`、`save/clipboard`、`openLightbox`。結果は次のアクション(`'files.loaded'` など)として返る。

## 追加する API(表)

| API | 用途 | 段階 | TUI での実装 |
|---|---|---|---|
| `files.url(path)` | `<img>` / ダウンロード用の URL | 2 | `client-core` で同等(ダウンロード先のファイル) |
| `files.upload(path, blob, { onProgress })` | 進捗付きアップロード | 2 | `shared_put` + 進捗 |
| `ui.modal` / `ui.menu` / `ui.panelBar`(L1/L2 用) | 本体の Modal / Menu / PanelBar と同じ DOM | 2 | 木の `Dialog` / `Menu` / `PanelBar` が対応 |
| `registerView` の `fullscreen` と `addNavItem` | チャットを隠す全画面とナビバー項目 | 2 | TUI の画面切替(`tui_nav_items`)に載せる |
| 戻る操作と履歴の統合 | view を `navHistory` に載せる | 2 | Esc |
| `clipboard`(テキスト・画像)/ `pickFiles()` / `save(blob, name)` | 貼り付け・アップロード・保存 | 2 | 端末のクリップボード / パスの入力 / 保存先 |
| `lightbox(src, alt)` | 画像の拡大 | 2 | 画像の描画層 |
| `registerScreen({ init, view, update })` | L3 の登録 | 3 | 同じ |
| `Node` の型(Rust + ts-rs) | 木の型 | 3 | 同じ |

- 「段階」は [CORE_PLUGINS.md](../CORE_PLUGINS.md) の計画の番号。
- 権限(`permissions`)の追加: `clipboard`・`files`(既存)。コアは宣言するだけ(ユーザーへの確認なし)。
