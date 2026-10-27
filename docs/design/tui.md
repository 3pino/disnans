# TUI の UI 部品と色

状態: 確定(方針)。実装は `crates/cli/src/tui/` が正

部品（Menu / Choice / Dialog / Prompt）は `crates/cli/src/tui/ui/modal.rs`、色トークンは `ui/theme.rs`、設定画面とナビゲーションバーの構造は GUI と共通の木（`client-core::view::ui`。[ui-tree.md](ui-tree.md)）から作る。操作の説明は [crates/cli/README.md](../../crates/cli/README.md)。以下は部品の方針。

- 当面は `tui/ui/` に部品を作り、GUI の `disnans.ui` / `components/ui/` と名前・props・イベント・値の型をそろえる。
- Nerd Font 前提。専用の代替文字セットは作らない。
- キー入力・マウス入力を `Action` に変換して部品に渡す。Tab / Shift+Tab はフォーカス移動、矢印は選択・値変更、Enter は決定、Space はトグル、Esc は一段戻る。ヒントはキー設定から作る。既存の画面のキー操作は移行時に維持する。
- モーダルはスタックの最上位だけが操作を受ける。画像がモーダルに重ならないよう配置を外す。選択モードや補完はリスト・ポップアップへのフォーカスとして扱う。
- マウスはクリック・ホイール・フォーカス移動に対応する方針。hover・ツールチップはフォーカスとヒント、ドラッグはキーの並べ替え操作で代替。画像は既存の描画層に任せる。
- ライト/ダークはテーマに従う方針で、専用の `theme.toml` は作らない。色は組み込みの既定（`ui/theme.rs`）で、GUI の `theme.css`（CSS の変数参照・oklch・color-mix）の読み込みは実装していない。
- 保存先も GUI と同じ分類。ユーザー共通は `/api/me/prefs`、TUI 固有は surface `tui` のデバイス設定。

## 部品の対応

「実装」は 2026-10 にコードで確認した現状（`tui/ui/modal.rs`・`settings.rs`・`view.rs`・`textbuf.rs`・`suggest.rs`）。

| GUI | TUI の部品 | 実装 |
|---|---|---|
| Button / IconButton | Button | あり（`modal.rs`） |
| Toggle | Toggle | 設定の行のオン/オフとして（`settings.rs`） |
| TextInput | TextField（既存 textbuf、1 行・複数行） | あり（`textbuf.rs`、1 行入力は `Prompt`） |
| select / SegmentedButton | Choice | あり（`modal.rs`） |
| Slider | Stepper | なし。数値は `Prompt` で入力 |
| Menu / MenuItem | Menu | あり（`modal.rs`） |
| Modal / confirm | Dialog（確認はキャンセルを既定） | あり（`modal.rs`） |
| SuggestList | Suggest（`@` `:` `/`） | あり（`suggest.rs`） |
| SettingRow / Section / Divider | Row / Section / Rule（core の設定定義を使う） | Row と節は設定画面にある（`settings.rs`）。Rule は専用部品なし |
| NavBar | Tabs | 画面切替バーとして（`view.rs` の `navbar_line`） |
| StatusLine / toast | StatusLine / Toast | 状態バーと通知の 1 行（`app.notice`）。Toast の部品はなし |
| SortableList | List（並べ替えはキー操作） | List の専用部品はなし。キー割り当ての編集のみ |
| Icon | Glyph（Nerd Font） | グリフを直接描く。専用部品はなし |

## 色トークンの対応

画面コードに RGB を直書きせず、用途のトークンから色を引く。表は対応の方針で、`Theme` にあるトークンは `ui/theme.rs` を見る。

| CSS 変数 | TUI の用途 |
|---|---|
| `--text` / `--bg` | 前景・背景（現在の既定背景はターミナルに従う） |
| `--text-muted` | 補助・区切り |
| `--accent` / `--accent-soft` | 選択・リンク・自分のリアクション |
| `--surface` / `--surface-2` | 行・ダイアログ・他人のリアクション |
| `--border` / `--border-focus` | 枠・フォーカス |
| `--mention` | メンション |
| `--danger` / `--success` / `--warning` | エラー・成功・注意 |
| `--mark` | 検索ヒット |
| `--on-accent` | アクセント背景上の文字 |
