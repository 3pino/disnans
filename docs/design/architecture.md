# アーキテクチャ（クライアントの分担と共通表示データ）

状態: 確定(実装済み)

通信の契約は [api/rest.md](../api/rest.md)、設定の保存先は [settings-storage.md](settings-storage.md)、TUI は [tui.md](tui.md)、設定画面とナビバーの共通の木は [ui-tree.md](ui-tree.md)。クレートの境界は [crates/client-core/README.md](../../crates/client-core/README.md)。

## 見た目と共通部品

見た目（トークン・リセット・共通部品のクラス）は、共有パッケージ **[@3pino/design-system](https://github.com/3pino/design-system)** にある。説明は同リポジトリの `DESIGN.md`。

- 取り込み: `app/package.json` の依存と、`app/src/app.css` の `@import '@3pino/design-system'`
- 本体だけのスタイル（検索ヒットの強調、チャット画面）は、`app.css` と各コンポーネントの `<style>` に置く
- 更新: 共有側でタグを打ち、依存のタグを更新する
- 部品や DOM を変えるときは、共有側の CSS と、UI 部品のパッケージ（下）・`lib/plugins/ui.ts`・[PLUGIN_UI.md](../plugins/ui.md) をそろえる
- 見た目の最終確認は利用者が行う

## UI 部品

小さな UI 部品（ボタン・メニュー・ダイアログ・設定の行・トグル・並べ替えのリストなど）は、共有パッケージ **[@3pino/ui-kit-web](https://github.com/3pino/ui-kit-web)** にある。説明は同リポジトリの `docs/ui.md`。

- 部品は Svelte のものだけ（v0.3.0 から。DOM の作り手は持たない）。見た目の正は `@3pino/design-system` のクラス
- プラグインの `disnans.ui`（`app/src/lib/plugins/ui.ts`）は、同じ Svelte の部品を **mount して**、できた DOM の要素を渡す。`ui/*.svelte` は、プラグインの引数（文字・要素・コールバック）を部品へ渡す薄い包み。`ui/mount.ts` が mount と後始末（画面から外れた要素の unmount、メニュー・モーダルの閉じ方。プラグインを外すときは `cleanupPluginUi`）、`ui/detachedEvents.ts` が、まだ document につながっていない要素でも押す・入力するが効くようにする（Svelte のイベントの委譲は、つながるまで受け手がいないため）。引数のエラーの種類と、トースト・確認・戻る・没入モードなど本体の機能は ui.ts がつなぐ
- アプリごとに違うことは差し込み口で渡す: アプリのロゴ（`defineBuiltinIcon`。`lib/icons.svelte.ts`）、Android の振動（`setHaptics`。`lib/haptics.ts`）
- 取り込み: `app/package.json` の依存（タグ指定）。ソースのまま配られるので、`app/vite.config.ts` で事前バンドルから外している（`optimizeDeps.exclude`）。更新は共有側でタグを打ち、依存のタグを更新する
- エクスプローラーの部品（@3pino/explorer-kit）も、同じ UI 部品を使う（重複した写しは無い）

## コアプラグイン（同梱のプラグイン）

- `app/core-plugins.lock.json` が、同梱するプラグインの版（リポジトリ・タグ・manifest・4 ファイルの sha256）を決める。`app/scripts/fetch-core-plugins.mjs`（`predev`・`prebuild` で動く）が GitHub のリリースから取り、sha256 と manifest を照合して `app/public/core-plugins/<id>/` に置く（取得のキャッシュは `app/.cache/`。どちらも Git には入れない）。
- 読み込みは `lib/plugins/host.svelte.ts` の `wanted()`。コアは利用者の設定でオフにできず、同じ ID の配布・開発用のものより優先する。
- 「ファイル」は、コアの fixplor が読めれば、その view を使う（`lib/coreFiles.svelte.ts`）。読めなければ内蔵の `FileExplorer` のまま。
- 詳しくは [proposals/core-plugins.md](../proposals/core-plugins.md)。

## エクスプローラー（共有フォルダの画面）

共有フォルダを見る画面（一覧・選択・コピー／移動・ゴミ箱・名前の変更・プロパティ）と、その決まり・状態は、共有パッケージ **[@3pino/explorer-kit](https://github.com/3pino/explorer-kit)** にある。
部品は特定のアプリの言葉を持たない（ファイラーのアプリ fixplor も同じ部品を使う）。Disnans は「サーバーの共有フォルダ」という置き場所と、Disnans の言葉（共有フォルダ・添付・本文のリンクの注意）を渡して使う。

- 取り込み: `app/package.json` の依存（タグ指定）。TypeScript と Svelte のソースのまま配られるので、`app/vite.config.ts` で開発サーバーの事前バンドルから外している（`optimizeDeps.exclude`）
- Disnans の実装を渡すところ: `app/src/lib/explorer/instance.ts`（置き場所 = `sharedApi`・項目の URL・共有フォルダの決まり `SHARED_RULES`（`specialDir` = `attachments`・文の `texts`）、本体から貸す機能 = 通知・確認・戻る・拡大表示・クリップボード・保存・OS からのドロップ）
- `components/FileExplorer.svelte`・`FileProperties.svelte`・`SharedEntryActions.svelte` は、部品へそれを渡すだけの薄い包み。`lib/sharedOps.ts`・`sharedTransfer.ts`・`trashFolder.ts`・`fileExplorer.ts`・`explorerDirs.ts` と `lib/stores/explorer*.svelte.ts`・`fileExplorer.svelte.ts` は、部品を Disnans の決まりで呼ぶ入口（これまでと同じ名前で使える）
- 画面の流れの試験は部品の側（explorer-kit の `FileExplorer.screen.test.ts`・`FileProperties.screen.test.ts`。メモリの中の偽の置き場所で確かめる）にある。Disnans の側の試験（`components/FileExplorer.test.ts`・`FileProperties.test.ts`・`lib/sharedOps.test.ts`）は、`instance.ts` が本物の `sharedApi`・`SHARED_RULES`・本体の機能へ正しくつながっていること（同名の確認・削除と取り消し・サーバーが変わったとき・添付の決まりと言葉・ゴミ箱の URL・OS のクリップボード・メッセージ検索）だけを確かめる
- 更新: 共有側でタグを打ち、依存のタグを更新する

## 土台（@3pino/app-kit-web）と本体の画面の状態

アプリの土台は、共有パッケージ `@3pino/app-kit-web`（別のリポジトリ `~/repos/app-kit-web`、v0.1.0）から取り込む。チャット・通話・設定を知らない部分だけを置く。

- `core/`（TypeScript）: プラットフォームの判定（Rust の注入値の名前は `app/src/lib/platformGlobal.ts` で `__DISNANS_PLATFORM__` に決める）・storage・localKeys の照合・invokeNative・戻る操作の履歴への接続・Esc の順・クリップボード・ドロップの既定動作・拡大と移動の計算など。
- `shell/`: 画面の土台の状態 `Shell`（トースト・確認・拡大表示・戻る操作の層）と、部品 `Toasts.svelte`・`ConfirmDialog.svelte`。

拡大表示の部品（写真・PDF・ライブ映像の全画面）は、共有パッケージ `@3pino/viewer-kit-web`（別のリポジトリ `~/repos/viewer-kit-web`、v0.1.0）から取り込む。`LightboxView`・ビューアー（画像・PDF）・`PdfThumb`・前後の決まりと型を持つ。URL・保存・エラーの文・種類の見分け・チャットの一覧は disnans が渡す（`components/Lightbox.svelte` が `ondownload`（Tauri の直接保存）と `errorText` を渡し、`lib/viewers.ts` が種類を決める）。共有の全画面（`ScreenShareViewer`）は同じ `LightboxView` を props で使う。

共有パッケージ `@3pino/app-kit-web` v0.2.0 は、アップデートの状態の機械（`updater`。仕組みへの口 `UpdateBackend` は `lib/updateBackend.ts` が Tauri へつなぐ）、設定の項目の部品（`settings/SettingsField`。木の描画 `SettingsTree` と読み書きは disnans に残る）、OS のドロップの部品（`core/dropFiles`）を持つ。Rust 側（apk-updater・system-bars・os-drop）の共有は設計メモ（app-kit-web の `docs/tauri-kit-design.md`）のみで、コードは未移動。

disnans に残るもの: `app/src/lib/platform.ts`（方針 `capabilities`）、`app/src/lib/stores/ui.svelte.ts`（タブ・パネル・通話・設定・検索・遷移の履歴。土台の `Shell` を `shell` として持ち、メンバーを委ねる）、`app/src/components/Toasts.svelte`・`ConfirmDialog.svelte`（土台の部品に ui の値と送り主のアイコンを渡すだけ）、診断ログ・システムバー・通知など、アプリごとの Tauri プラグインと結び付くもの。

呼び出し側は `ui` だけを使い、土台のメンバー（`toast`・`confirm`・`lightbox`・`back` など）も `ui` 経由のまま変えていない。

## クライアントと共通表示データ

- 製品の GUI は Tauri（Windows・Linux・Android）。チャットは Rust の接続を使う。製品としてのブラウザー対応はしない。`vite dev` は Tauri の接続先と、テスト（vitest・`app/scripts/touch-check.mjs` の Chromium）のためにあり、通常のブラウザーから実サーバーへつなぐ経路は持たない。
- GUI と CLI/TUI は同じバージョンで配布する前提。共通表示データの版ずれを吸収する契約は設けない。
- `crates/client-core/src/view/` は「何を出すか」を決める。HTML、文字幅、折り返し、色などの描画は持たない。GUI は Svelte、TUI は ratatui で描画する。
- 本文の Markdown の木は Rust で作り、履歴・検索・チャットイベントの応答に付ける。一覧の各メッセージについて別々に invoke しない。Android の受け渡しは JSON の base64 なので、追加するデータ量に注意する。
- 送信中・編集の仮表示は `api_markdown_tree(body)` を操作ごとに 1 回だけ呼ぶ。返るまでは改行・メンションだけのプレーン表示。古い本文の木は使わず、結果が返った時点で本文が一致するときだけ付ける。失敗しても送信を再試行しない。
- Rust を呼べない環境（テストなど）ではプレーン表示。製品用の解析を TypeScript に二重に持たない。
- 続けての投稿（同じ人・5 分）と日付の区切りは GUI に判定を残し、core への一本化はしない（決定）。未読の線で続きを切ることや送信中の末尾追加は GUI だけの規則で、ローカルの時刻帯や履歴のページの継ぎ目も GUI が扱う。計算は 5000 件でも約 1ms（Node での計測）で、invoke にすると更新のたびに IPC が増え、WASM にするには view の別クレート化が要る。続きの判定は Rust と共通の fixture で一致を保つ。続きの判定にスレッドの条件は含めない。
- メンションの表示名は GUI の users マップから差し込む。通知文言はサーバーが作る。「不明なユーザー」は Rust・TS それぞれ 1 つの定数にまとめ、fixture で照合する。
- 入力欄の補完（`@`・`:`・行頭の `/`）の規則は、core の `view/suggest.rs` と GUI の `app/src/lib/suggest/` が持ち、`fixtures/suggest/` で一致を確かめる。絵文字の表は core の `view/emoji.rs` が正で、GUI へは生成物（`emojiNames.generated.ts`）として出す。
- fixture は `crates/client-core/tests/fixtures/view/` と `fixtures/prefs/`。削除した TS の解析・正規化の出力も Rust 側の回帰テストとして残す。fixture 外の入力まで旧 TS と完全に同一である保証はない。
