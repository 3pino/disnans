# 設計

実装の設計と確定した方針をまとめる。未実装・確認待ちの作業は [FEEDBACKS.md](../FEEDBACKS.md) で管理する。過去の検討経緯は git の履歴に残す。

- 通信の契約・添付と共有フォルダの操作: [API.md](API.md)
- サーバーの運用・WebDAV の接続・バックアップ: [server README](../crates/server/README.md)
- プラグイン API: [PLUGINS.md](PLUGINS.md)、GUI の部品: [PLUGIN_UI.md](PLUGIN_UI.md)
- テーマ: [THEMES.md](THEMES.md)
- GUI と TUI の共通の画面の木: [UI_TREE.md](UI_TREE.md)

## 見た目と共通部品

見た目（トークン・リセット・共通部品のクラス）は、共有パッケージ **[@3pino/design-system](https://github.com/3pino/design-system)** にある。説明は同リポジトリの `DESIGN.md`。

- 取り込み: `app/package.json` の依存と、`app/src/app.css` の `@import '@3pino/design-system'`
- 本体だけのスタイル（検索ヒットの強調、チャット画面）は、`app.css` と各コンポーネントの `<style>` に置く
- 更新: 共有側でタグを打ち、依存のタグを更新する
- 部品や DOM を変えるときは、共有側の CSS と、`components/ui/`・`lib/plugins/ui.ts`・[PLUGIN_UI.md](PLUGIN_UI.md) をそろえる
- 見た目の最終確認は利用者が行う

## クライアントと共通表示データ

- 製品の GUI は Tauri（Windows・Linux・Android）。チャットは Rust の接続を使う。「開発用ブラウザー」は `vite dev` をブラウザーで開く経路を指し、デスクトップ GUI とは別。開発用の JS WebSocket は残すが、製品としてのブラウザー対応はしない。
- GUI と CLI/TUI は同じバージョンで配布する前提。共通表示データの版ずれを吸収する契約は設けない。
- `crates/client-core/src/view/` は「何を出すか」を決める。HTML、文字幅、折り返し、色などの描画は持たない。GUI は Svelte、TUI は ratatui で描画する。
- 本文の Markdown の木は Rust で作り、履歴・検索・チャットイベントの応答に付ける。一覧の各メッセージについて別々に invoke しない。Android の受け渡しは JSON の base64 なので、追加するデータ量に注意する。
- 送信中・編集の仮表示は `api_markdown_tree(body)` を操作ごとに 1 回だけ呼ぶ。返るまでは改行・メンションだけのプレーン表示。古い本文の木は使わず、結果が返った時点で本文が一致するときだけ付ける。失敗しても送信を再試行しない。
- 開発用ブラウザーは Rust を呼べないためプレーン表示。製品用の解析を TypeScript に二重に持たない。
- 続けての投稿（同じ人・5 分）と日付の区切りは GUI に判定を残し、core への一本化はしない（決定）。未読の線で続きを切ることや送信中の末尾追加は GUI だけの規則で、ローカルの時刻帯や履歴のページの継ぎ目も GUI が扱う。計算は 5000 件でも約 1ms（Node での計測）で、invoke にすると更新のたびに IPC が増え、WASM にするには view の別クレート化が要る。続きの判定は Rust と共通の fixture で一致を保つ。続きの判定にスレッドの条件は含めない。
- メンションの表示名は GUI の users マップから差し込む。通知文言はサーバーが作る。「不明なユーザー」は Rust・TS それぞれ 1 つの定数にまとめ、fixture で照合する。
- 入力欄の補完（`@`・`:`・行頭の `/`）の規則は、core の `view/suggest.rs` と GUI の `app/src/lib/suggest/` が持ち、`fixtures/suggest/` で一致を確かめる。絵文字の表は core の `view/emoji.rs` が正で、GUI へは生成物（`emojiNames.generated.ts`）として出す。
- fixture は `crates/client-core/tests/fixtures/view/` と `fixtures/prefs/`。削除した TS の解析・正規化の出力も Rust 側の回帰テストとして残す。fixture 外の入力まで旧 TS と完全に同一である保証はない。

## 設定の保存先

確定方針は「設定は原則サーバーに保存」。接続先 URL やデバイス ID のように接続前に必要な情報はローカルに置く。以下は現行の保存先であり、その他のローカル項目をすべて例外として確定したわけではない。例外の範囲の見直しは [FEEDBACKS.md](../FEEDBACKS.md) に残す。

| 現行の保存先 | 内容 |
|---|---|
| ユーザー共通 `/api/me/prefs` | テーマ、ホットキー、Enter キー、コマンドの別名、＋メニュー、メッセージの表示、ナビの項目、機器に依存しない通話の設定 |
| デバイスごと `/api/me/devices/{id}/prefs` | 通話の入力・出力機器、デバイスの種類、ナビバーを隠す、画面の向き、プラグインの無効化・開発フォルダ |
| ローカル | 接続先 URL、開発ユーザー、デバイス ID、下書き、開発・実験フラグ、更新確認時刻（`updateCheckedAt`）、プラグインの保存データ、キャッシュなど |

- 各項目の保存先・型・既定値・正規化の正本は `client-core/src/view/settings.rs` の `DEFINITIONS`。サーバーは prefs を JSON オブジェクトとして保存し、クライアントの core が表示用に正規化する。未知のキーは残す。
- ユーザーとデバイスの値はサーバーで合成しない。クライアントが両方を読み、デバイスの指定を優先する。
- Tauri の `api_prefs` / `api_set_prefs` は `{ raw, view }` を返す。`raw` は保存の下地、`view` は正規化した表示用。変更した項目だけを raw に加えて書き戻し、表示のために補った既定値を保存しない。デバイス設定は `api_device_prefs_read/write` が正規化した値を返す。
- 既定値の TS の写しは `defaults.json` と照合する。開発用ブラウザーはその写しで欠けたキーだけを補う。`api_settings_definitions` は登録済みだが、GUI の設定画面を定義から生成する仕組みではない。
- 旧 localStorage は、サーバーに無い項目だけ取り込み、既存の値を上書きしない。元のキーは消さない。取り込みの値は raw に入れ、保存の応答を Rust が正規化する。＋メニューの版付き移行は TS に残す。
- デバイス ID はクライアント発行の ULID。`LocalStore::device_id(Surface)` が surface ごとに保存し、再利用する。ID は認証情報ではない。名前は既定で OS 名。デバイス一覧と prefs は別に保存する。
- **デバイス台数の上限は設けない**。ユーザーごとの ID の分離、名前・設定サイズの検査は維持する。API は [API.md](API.md) を参照。
- 起動時はキャッシュを表示し、サーバーの応答で置き換える。ユーザー共通は `prefs.updated` で読み直す。デバイス設定の変更イベントはなく、設定画面やフォーカス・可視状態の復帰で読み直す（連続した再取得は 5 秒間抑制）。
- デバイスの一覧・名前変更・削除は、Tauri の GUI（設定の「デバイス」）に実装済み。このデバイスは一覧から削除できない。TUI は設定の「接続」→「デバイス」で、このデバイスの名前だけを変えられる（一覧・削除は未実装）。通知購読の状態の保存先も未整理。

## TUI の互換 UI 部品（確定方針）

部品（Menu / Choice / Dialog / Prompt）・色トークン・設定画面は `crates/cli/src/tui/` にある。設定画面とナビゲーションバーの構造は GUI と共通の木（`client-core::view::ui`）から作る（[UI_TREE.md](UI_TREE.md)）。以下は部品を増やす際の設計方針で、すべてが実装済みとは限らない。残作業は [FEEDBACKS.md](../FEEDBACKS.md) と [UI_TREE.md](UI_TREE.md) に置く。

- 当面は `tui/ui/` に部品を作り、GUI の `disnans.ui` / `components/ui/` と名前・props・イベント・値の型をそろえる。
- いずれプラグイン UI を TUI にも出す。状態・props・描画を分離し、描画に依存しない宣言的な木（`client-core::view::ui`。いまは設定画面とナビゲーションバーだけ）に載せる。現行 `disnans.ui` は DOM を返す命令型なので、そのままでは TUI で使えない。宣言型 API と JS ランタイム・実行対象の設計が別途必要。
- Nerd Font 前提。専用の代替文字セットは作らない。
- キー入力・マウス入力を `Action` に変換して部品に渡す。Tab / Shift+Tab はフォーカス移動、矢印は選択・値変更、Enter は決定、Space はトグル、Esc は一段戻る。ヒントはキー設定から作る。既存の画面のキー操作は移行時に維持する。
- モーダルはスタックの最上位だけが操作を受ける。画像がモーダルに重ならないよう配置を外す。選択モードや補完はリスト・ポップアップへのフォーカスとして扱う。
- マウスはクリック・ホイール・フォーカス移動に対応する方針。hover・ツールチップはフォーカスとヒント、ドラッグはキーの並べ替え操作で代替。画像は既存の描画層に任せる。
- ライト/ダークはテーマに従い、GUI の `theme.css` を読む。専用の `theme.toml` は作らない。CSS の変数参照・oklch・color-mix と明暗ルールの選び方、色数の少ない環境での変換は未実装。読めない値は既定値に戻す。
- 保存先も GUI と同じ分類。ユーザー共通は `/api/me/prefs`、TUI 固有は surface `tui` のデバイス設定。

### 部品の対応

| GUI | TUI の部品 |
|---|---|
| Button / IconButton | Button |
| Toggle | Toggle |
| TextInput | TextField（既存 textbuf、1 行・複数行） |
| select / SegmentedButton | Choice |
| Slider | Stepper |
| Menu / MenuItem | Menu |
| Modal / confirm | Dialog（確認はキャンセルを既定） |
| SuggestList | Suggest（`@` `:` `/`） |
| SettingRow / Section / Divider | Row / Section / Rule（core の設定定義を使う） |
| NavBar | Tabs |
| StatusLine / toast | StatusLine / Toast |
| SortableList | List（並べ替えはキー操作） |
| Icon | Glyph（Nerd Font） |

### 色トークンの対応

画面コードに RGB を直書きせず、用途のトークンから色を引く。表は共通化の対応方針で、すべてのトークンが現行 Theme に実装されているわけではない。

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

## 別アプリ・画面の切り出し（検討中・未着手）

2026-10 の調査（FEEDBACKS「ファイルエクスプローラー機能を別のアプリとして切り出したい」）。**方針の候補であり、実装はまだ。**


#### 1. 現状: プラグインで「画面」をどこまで作れるか
- 作れるもの(API v15 / `docs/PLUGINS.md`): `registerView`/`openView`(パネル、モバイルは全画面。`containerEl` に DOM を描く命令型)、`addCommand`(パレット・ホットキー・スラッシュ。ナビバーにも出せる)、`addSettingTab`、`addStatusBarItem`、通話の拡張(`disnans.call.addPanel/addButton`)、`files`(共有フォルダ API、permissions:["files"])、`loadData/saveData`、`holdBackground`、通知、`styles.css`。
- 使える部品: `disnans.ui`(button/toggle/input/segmented/navbar/divider/setting/icon/toast/confirm、`PLUGIN_UI.md`)と DS のグローバル CSS クラス・CSS 変数。**Svelte 部品・ストア・本体の import は不可**(プラグインは配布された JS 単体で、`disnans` オブジェクトだけを受け取る)。
- できないこと(エクスプローラーに必要なもの): Modal/Menu/MenuItem/PanelBar/SortableList/Lightbox 相当の部品、全画面で既存画面(チャット等)を隠す指定(`shell-panel-files` は本体専用の分岐)、ナビバー項目の専用追加(コマンド経由のみ)、戻る操作とパネルの統合(`ui.onBack` はあるが履歴に載る画面にはできない)、長押し・範囲選択などのジェスチャーの共通部品、クリップボード(画像/テキスト)・ファイル選択・ダウンロード/保存、PDF サムネイル、ドラッグ&ドロップ、アップロード進捗付きの `files.write`、複数選択の操作、URL(`sharedFileUrl`)の取得。

#### 2. エクスプローラーの依存(FileExplorer.svelte 1185 行ほか)
本体のみにあるもの / プラグインに足りない API:
| 依存 | 現状の置き場 | 足りない API(プラグイン側) |
|---|---|---|
| 共有フォルダの REST | `transport/shared.ts`(sharedApi, uploadShared) | `files` は list/read/write/mkdir/remove/move/copy ありで概ね足りる。足りない: **進捗付きアップロード**、**ファイル/画像の URL**(`<img src>`、DL 用)、`SharedEntry.file_id/mime` |
| 一覧の写し・更新 | `stores/sharedIndex`(files.changed で破棄)、`fileExplorer`、`explorerView/Buffer/Selection` | `files.onChange` あり。写し(キャッシュ)は各プラグインが自前 |
| 部品 | `ui/IconButton, PanelBar, Button, Modal, TextInput, Menu, MenuItem`、`SharedEntryActions`、`PdfThumb` | **Modal / Menu / PanelBar / IconButton を `disnans.ui` に追加**(今は toast・confirm のみ) |
| 画面の置き場 | `Shell` の `panel.kind==='files'`(チャットを隠して全域)、`ui.openFiles` | **全画面ビュー**(`openView({ fullscreen })`)、ナビバー項目(`addNavItem`) |
| 戻る・履歴 | `navHistory.Panel` | view を履歴に載せる(Android 戻る/Alt+←で閉じる) |
| 設定 | `explorerView`(表示形式を prefs/deviceSettings) | `loadData/saveData` で代替可 |
| 入出力 | `clipboard*`、`clipboardPaste`、`dropFiles`、`lib/platform`、Lightbox(`ui.lightbox`) | **clipboard、Lightbox(画像表示)、ファイル選択、ダウンロード保存、長押し** |
| テーマ | CSS 変数・DS クラス | 既に使える |
| コマンド | `app:open-files` | `addCommand` で可 |
結論: 足りないのは「部品(Modal/Menu/PanelBar/Lightbox)」「全画面ビュー+ナビバー項目」「クリップボード/ファイル選択/保存」「アップロード進捗」。

#### 3. 切り出しの粒度
- **A. 内蔵プラグイン(同梱だが plugin API だけに依存)**: 同じ WebView・同じ認証/WS を使うので共有問題なし。利点: 最小コスト、API が実戦で育つ、配布・オン/オフ(設定のプラグイン一覧)が使える。欠点: 命令型 DOM(Svelte が使えない)ので 1185 行の書き直し(or Svelte を IIFE にビルドして同梱)。apk は分かれない。工数: API 追加 2〜3 週 + 移植 1〜2 週。
- **B. 別配布のプラグイン(JS+CSS、部品は UI SDK)**: A の延長。Svelte で作って UI SDK(部品を Svelte でも提供)にすれば再利用が楽。利点: 誰でも画面を作れる。欠点: SDK の安定化・版管理が必要。工数: A の後 +2〜3 週。
- **C. Android の別 Activity + 別 WebView(同一 apk)**: 同一プロセス・同一 UID なので Intent で起動し、サーバーURL/トークン相当は SharedPreferences/ContentProvider 共有が可能。WS は Rust のチャット(`chat_start`)が 1 つ必要で、別 WebView 側は IPC か別の接続になる。**Tauri 公式**: マルチ WebView/ウィンドウは Android 未対応(issue #11528, 2024〜)。2026-08 に issue #15857、2026-10-12 に PR #16262(`feat(android): use a task per window, activity embedding for multiwebview`)が open。つまり**現時点で公式の安定機能ではない**(PR 未マージ)。自前で Kotlin の Activity を足す手もあるが、Tauri の WebView 起動/IPC の枠外で保守が重い。工数: 公式待ちなら不明、自前なら 4〜8 週+保守。
- **D. 別 apk**: 署名と shared UID は同一鍵が必要(共有 UID は非推奨)。認証/設定の受け渡しは ContentProvider/bound service か、各 apk が独立に接続(サーバー URL を入力 or Intent で受け取り)。配布は release.yml に apk を増やし、更新は個別(版の食い違い対策が要る)。利点: 完全に独立(プロセス・クラッシュ・更新)、Android の最近のアプリに別アイコンで出る。欠点: 設定・認証の二重管理、配布/更新の複雑化、デスクトップには無関係。工数: 最小の別アプリ化でも 3〜6 週+運用負荷。
- 参考(デスクトップ): Tauri v2 は複数ウィンドウ/マルチ WebView が使える(WebView の追加は `unstable` 機能)。デスクトップなら別ウィンドウで同じアプリ内に出せる。

#### 4. 推奨する道筋
1. **A: 内蔵プラグイン化**でプラグイン API を育てる(エクスプローラーを最初の利用者にする)。
2. 共通部品を UI SDK として整理(Svelte 部品を `disnans.ui` とそろえる。DS 化済みなので CSS は共有できている)。
3. 公式の Android マルチ WebView(#16262)がマージされたら C を評価。別 apk(D)は、サーバー URL・認証の受け渡し(1 回の入力 or Intent)で済む独立アプリが欲しくなった時点で。
最初の一歩(最小の API 追加 3〜5 個):
- (a) `disnans.ui.modal` / `ui.menu`(位置指定のメニュー)/ `ui.panelBar`(本体の Modal/Menu/PanelBar と同じ DOM)
- (b) `registerView` の `fullscreen`(チャットを隠す)+ `addNavItem`(ナビバー項目)+ 戻る操作の履歴統合
- (c) `files.url(path)`(`<img>`/ダウンロード用)と `files.upload(path, blob, { onProgress })`
- (d) `disnans.clipboard`(テキスト/画像)、`disnans.pickFiles()`、`disnans.save(blob, name)`
- (e) `disnans.lightbox(src, alt)`
その上でエクスプローラーを `examples/explorer/`(内蔵プラグイン、`permissions:["files","clipboard"]`)に移し、本体の `panel.kind==='files'` 分岐・`app:open-files` を、プラグインのコマンド・view に置き換える。

#### 5. 環境ごとの扱い
- デスクトップ(Tauri): A/B は同一 WebView。C 相当は別ウィンドウで可能(マルチウィンドウは対応)。
- Android: A/B は同一 WebView(通知・戻る・safe-area は PanelBar/Shell が担当)。C/D は上記のとおり公式待ち or 自前。
- TUI: プラグインは JS の DOM を返す命令型なので TUI では動かない(`docs/UI_TREE.md` は設定画面とナビバーだけの共通木)。エクスプローラー相当の TUI は、`crates/client-core` の shared REST を使う別実装(core の `view::ui` に画面の木を足す方向)。FEEDBACKS にある「宣言的な木 API」と合流させるのが筋で、プラグイン API の宣言型化が前提。
#### リスク
- 命令型 DOM での 1185 行の書き直しは回帰が起きやすい(テストの移植が要る)。Svelte を同梱ビルドする案も比較に値する。
- API を増やすほど後方互換(apiVersion)の負担が増える。最初は内蔵(本体と同時に更新)で割り切る。
