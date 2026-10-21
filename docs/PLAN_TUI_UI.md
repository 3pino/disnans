# TUI の UI 部品の設計案

状態: 決定済み（末尾）。段階 1（Theme）は実装済み。関連: [PLUGIN_UI.md](PLUGIN_UI.md)（GUI の `disnans.ui`）、[PLAN_SHARED_VIEW.md](PLAN_SHARED_VIEW.md)、[FEEDBACKS.md](../FEEDBACKS.md)。

## 結論（先に）

- まず **TUI 専用の部品ライブラリ**（`crates/cli/src/tui/ui/`）を作る。宣言的な木を client-core に置くのは、TUI でプラグインの UI を出すと決まってから（段階 2）。
- ただし部品の**名前・props・イベント・値の型**は GUI の `disnans.ui` / `components/ui/` と揃える。あとで木へ持ち上げるとき、機械的に移せる。
- 色は **意味のトークン**（`accent`、`text-muted` など）で参照し、色の値は Theme から引く。画面コードに `Color::Rgb(..)` を書かない。

## 1) 部品のカタログ

| 部品（GUI） | TUI | 備考 |
|---|---|---|
| Button / IconButton | `Button` | `[ ラベル ]`。Enter / Space。アイコンは Nerd Font 前提の 1 桁（無ければ文字） |
| Toggle | `Toggle` | `[x]` / `[ ]`（または `◖●◗`）。Space |
| TextInput | `TextField` | 既存の `textbuf` を使う。1 行・複数行の両方 |
| SegmentedButton / select | `Choice` | 横並び（←→）か縦リスト（↑↓）。件数が多ければリスト |
| Slider | `Stepper` | ←→ で増減、数値表示。バー表示は任意 |
| Menu / MenuItem | `Menu` | 縦リスト。選択行を反転。ショートカット文字を右端に出す |
| Modal / confirm | `Dialog` | 中央に枠。`confirm` は `[OK] [キャンセル]`（既定はキャンセル側） |
| SuggestList | `Suggest` | 入力欄の上に出す補完（`@` `:` `/`） |
| SettingRow / Section / Divider | `Row` / `Section` / `Rule` | ラベル左・操作右。区切りは罫線 |
| NavBar | `Tabs` | 既存の Chat/Settings 行 |
| StatusLine / toast | `StatusLine` / `Toast` | 既存のメッセージ行。toast は数秒で消える行 |
| SortableList | `List`（並べ替えは `Alt+↑↓`） | ドラッグはキー操作に置換 |
| Icon | `Glyph` | 名前 → 文字の表（Lucide は出せないので主要なものだけ） |

TUI では別の形にするもの: hover（無し。フォーカスで代替）、ドラッグ（キー）、ツールチップ（ステータス行のヒント）、画像（既存の `graphics`。部品ではなく描画層）、影・角丸・アニメーション（無し。ピルは Powerline の丸い端 U+E0B6/E0B4 だけ）。

## 2) 宣言的な木を core に置くか

案 A: TUI 専用（`tui/ui/`）。案 B: core に `view::ui`（描画に依存しない木 `Node { kind, props, children, on_* }`）を置き、GUI は DOM、TUI は ratatui で描く。

- B が要るのは「プラグインが組んだ UI を TUI でも出す」ときだけ。プラグインは JS で、今の `disnans.ui` は **DOM 要素を返す命令型**なので、そのままは TUI に出せない。木を返す宣言型 API（`ui.view({...})`）を別に足す必要があり、設計が大きい（FEEDBACKS の「TUI向けのプラグイン」の設計待ちと同じ話）。
- shared view との関係: view は「何を出すか」（データ）だけを持つ原則。木は「どんな操作部品をどう並べるか」で一段上。置くなら `view::ui` とは別モジュールにし、**描画（幅・色・折り返し）は持たない**原則は守る。
- 判断: いま A。状態（フォーカス・選択・開閉）と描画を分け、`Component { fn handle(Key) -> Outcome, fn render(&mut Frame, Rect, &Theme) }` の形にしておけば、B へは「props を木のデータにして core へ移す」だけで済む。重複しやすい**値の規則**（選択肢の正規化・設定項目の型・既定値）は既に `view::settings` にあるので、設定画面は最初から core の定義を読んで部品を生成する（B の先取り）。

## 3) フォーカスとキーの共通規則

- 画面は**フォーカスの木**を持つ。Tab / Shift+Tab は同じ階層の次 / 前、↑↓ はリスト内、←→ は横並び・値の増減、Enter は決定、Space はトグル、Esc は 1 つ戻る（モーダルを閉じる → 選択モードを抜ける → 入力へ）。
- キーは部品が直接読まず、`Action`（Next/Prev/Up/Down/Activate/Cancel/…）に既存の `Keymap` で変換してから渡す（キー変更の機能の土台）。ショートカットの表示は `Keymap` から作るので、変えた設定がそのままヒントに出る。
- モーダルは**スタック**。一番上だけがキーを受け、下は暗くして描く（DIM）。モーダルが開いている間、下の画面と履歴の画像は再描画しない（画像は上に重ならないよう、モーダルの矩形と重なる配置を外す）。
- 選択モード・リアクション入力は「モード」ではなく、**履歴リストにフォーカスがある状態**と**ポップアップの Choice/TextField**として表す。今の `Mode` enum は段階的に消える。
- 低いキー操作に頼らない: マウスは未対応のまま（後で `Activate` に写像するだけ）。

## 4) 色・スタイルのトークン

`Style` を直接組まず、`Theme { accent, text, text_muted, surface, surface_2, border, danger, success, warning, mention, mark, on_accent, … }`（各 `Color`）から作る。

| CSS 変数 | TUI の用途 |
|---|---|
| `--text` / `--bg` | 既定の前景（背景は端末の既定色のまま使う） |
| `--text-muted` | 区切り・リストの記号・補助（今の DarkGray） |
| `--accent` / `--accent-soft` | 選択・リンク・Chat タブ・自分のリアクション |
| `--surface` / `--surface-2` | リアクション（他人）・選択行・ダイアログの背景 |
| `--border` / `--border-focus` | 枠・フォーカス中の枠 |
| `--mention` | `@メンション` |
| `--danger` / `--success` / `--warning` | エラー・成功・注意（今の Red/Green/Yellow） |
| `--mark` | 検索ヒット・ハイライト |
| `--on-accent` | accent 背景の上の文字 |

読み込み: ① 組み込みの既定（今の色を表にしたもの。ライト/ダークは端末の背景から推定せず、既定はダーク 1 つ）② 設定 `~/.config/disnans/theme.toml` かテーマプラグインの `theme.css` から `--名前: 値` を読む。CSS の値は oklch が主なので、**oklch → sRGB の変換**（`hue/chroma/l` の式）と `color-mix` の簡易対応を実装する（変数参照 `var()` は 1 段だけ解く）。解釈できない値は無視して既定にする。端末が 24bit 非対応なら 256 色に丸める（`COLORTERM` で判定）。
GUI のテーマ（`theme.css`）をそのまま TUI でも使えるのがゴール。ただし `:root[data-theme=...]` やメディアクエリは読まず、ダーク用の値だけ使う（要決定）。

## 5) 段階的な移行

1. **Theme と Style の置き場**（`tui/ui/theme.rs`）。今の `Color::Rgb(..)` / `DarkGray` を、トークン経由に置換（見た目は変えない）。最初の 1 歩はこれ。
2. `Action` と `Focus` の整理（`Keymap` → `Action`、フォーカス移動の共通化）。
3. `Dialog` + `confirm`。使う先: 投稿の削除確認、送信結果不明の再送確認（今はステータス行）。
4. `Menu` / `Choice`: リアクション選択（今は絵文字を打つ）→ 候補の Menu、選択モードの操作一覧、設定の select。
5. `Suggest`: `@` `:` `/` の補完（FEEDBACKS の補完）。
6. 設定画面: `view::settings` の定義から `Row` を生成（Toggle / Choice / Stepper / TextField）。Settings タブがここで有効になる。
7. （決まれば）宣言の木を core へ。プラグイン UI を TUI に出す。

各段で、画面の出力（バッファの文字と Style）を比べるテストを付ける（最近の「テストが経路を見ていない」の反省から、描画結果まで見る）。

## 6) 決定事項（ユーザー回答）

1. **プラグイン UI はいずれ TUI にも出す想定**で設計する。部品の名前・props・イベントは、core の宣言的な木へ持ち上げられる形にする。木の置き場は `client-core` の `view::ui`（描画に依存しない）。今すぐ移さないが、段階 3 以降の部品は「状態 + props（データ）+ 描画」を分けて書く。
2. Nerd Font 前提（アイコン・ピルの端に使う。代替文字は用意しない）。
3. ライト/ダークは**テーマに従う**（`theme.css` の `:root` と、ダーク用の `prefers-color-scheme`/`data-theme` の値の選び方は、テーマの読み込みの実装時に決める）。
4. テーマは **GUI の `theme.css` を読む**（専用の `theme.toml` は作らない）。
5. **マウスに対応する**（クリック = `Activate`、ホイール = スクロール、フォーカスの移動）。入力は `Action` に写像する。段階 2 でキーと一緒に設計する。
6. 設定はサーバーのデバイス設定（`/api/me/devices/{id}/prefs`、surface は `tui`）に保存する。ユーザー共通の設定は GUI と同じ `/api/me/prefs`。

## 7) 進み具合

- 段階 1: `tui/ui/theme.rs`（`Theme`、`DEFAULT`、`current()`）を追加し、`view.rs` の色をすべてトークン経由に置換した（見た目は変えていない）。次は `theme.css` の読み込み（oklch → sRGB、`var()`、`color-mix`）。
