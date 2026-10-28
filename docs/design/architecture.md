# アーキテクチャ（クライアントの分担と共通表示データ）

状態: 確定(実装済み)

通信の契約は [api/rest.md](../api/rest.md)、設定の保存先は [settings-storage.md](settings-storage.md)、TUI は [tui.md](tui.md)、設定画面とナビバーの共通の木は [ui-tree.md](ui-tree.md)。クレートの境界は [crates/client-core/README.md](../../crates/client-core/README.md)。

## 見た目と共通部品

見た目（トークン・リセット・共通部品のクラス）は、共有パッケージ **[@3pino/design-system](https://github.com/3pino/design-system)** にある。説明は同リポジトリの `DESIGN.md`。

- 取り込み: `app/package.json` の依存と、`app/src/app.css` の `@import '@3pino/design-system'`
- 本体だけのスタイル（検索ヒットの強調、チャット画面）は、`app.css` と各コンポーネントの `<style>` に置く
- 更新: 共有側でタグを打ち、依存のタグを更新する
- 部品や DOM を変えるときは、共有側の CSS と、`components/ui/`・`lib/plugins/ui.ts`・[PLUGIN_UI.md](../plugins/ui.md) をそろえる
- 見た目の最終確認は利用者が行う

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
