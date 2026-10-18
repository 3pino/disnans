# 共通の表示データ（client-core の view）と GUI の切り替え

状態: 進行中（GUI の切り替えは判断待ち）。未対応の一覧は [FEEDBACKS.md](../FEEDBACKS.md)。

## 目的

メッセージの見た目を決めるロジック（並び・日付の区切り・同じ人の続き・本文の構文木・メンションの名前・通知の文言）を、GUI（TypeScript）と TUI（Rust）で二重に持たないようにする。ロジックは `crates/client-core/src/view/` に一つだけ置き、描画（Svelte の部品、端末の幅と折り返し）は各画面に残す。

## 原則

- core は描画に依存しない。文字の幅・折り返し・色は持たない。
- 表示データは「何を出すか」だけを表す。HTML の文字列は作らない（GUI は木を描き、TUI は行を描く）。
- 同じ判断は fixture（`crates/client-core/tests/fixtures/view/*.json`）を、Rust と TypeScript の両方で通して保証する。fixture の `expected` は、作成時点の TypeScript の出力を記録したもの（特徴付け）。変えるときは理由を残す。
- スレッドは廃止済み。続き（まとめ）の判定から、スレッドの条件は外した。

## 現在の状態

| 段 | 内容 | 状態 |
|---|---|---|
| V0 | fixture（Markdown・メンション・続き）と、TypeScript 側での検証 | 完了 |
| V1 | 環境の方針（`platform.rs`。`surface` は `tauri` `tui` `cli`）を core に移す | 完了 |
| V2a | `view` モジュール（行の並び・日付・同じ人の続き・メッセージの行） | 完了 |
| V2b | TUI の表示を `view` に接続（名前の省略・ボット名・メンションの表示を含む） | 完了（TUI のみ） |
| V3 (Rust) | Markdown の構文木を `view/markdown.rs` に移し、fixture で確かめる | 完了（GUI は未変更） |
| V3 (GUI) | GUI が Rust の本文の木（`markdown`）を使う。TypeScript の parse は Rust の木が無いときだけ使う | 実装済み（CI 待ち）。`messageRows.ts` は残す |
| V4 | 作成・名前・通知の文言を `view` に移す | 未着手 |
| V5 | 設定項目の定義とコマンド・ナビ項目を `view` に移す | 未着手（端末・ユーザーの設定の境界が決まってから） |
| V6 | 残った重複の削除 | 未着手 |

## V3 の方式（実装済み）

- 本文の木は、履歴（`api_messages`）・検索（`api_search_messages`）の結果と、チャットの `message.created` / `message.updated` イベントの `message` に、`markdown` として付けて渡す（Rust の `view::markdown::add_to_message`）。
- 別の呼び出し（一件ずつの invoke）は作らない。木は既存の応答に乗るので、往復は増えない。
- GUI は `treeOf(body, markdown)` を使う。`markdown` が配列なら使い、無ければ（ブラウザー版・送信直後の仮表示など）TypeScript の `parse` で作る。
- ブラウザー版は Rust を使えないため、`markdown.ts` の parse は残す（削除できるのは Tauri の経路だけ）。両方の正しさは fixture（`markdown.json`）で保つ。

### payload の測定（V3 の前に行った。TypeScript で測定）

本文の木の JSON の大きさ（`JSON.stringify(parse(body))`）と、メッセージの JSON（ID などを含む、約 250 バイト）を、9 件の典型的な本文で比べた。

| 本文の例 | メッセージ（バイト） | 本文の JSON（バイト） | 木（バイト） |
|---|---|---|---|
| 短い文 | 233 | 13 | 71 |
| 長め（メンション・改行つき） | 286 | 66 | 255 |
| 箇条書き（入れ子） | 251 | 31 | 331 |
| 引用 | 241 | 21 | 186 |
| 300 文字の英字 | 522 | 302 | 360 |
| 日本語 180 文字 | 366 | 146 | 204 |

- 9 件の合計: メッセージ 2642 バイト、木 1695 バイト（1 件あたり平均 約 190 バイト）。
- 木は本文の繰り返しと型の印を含むので、本文の 1〜3 倍程度。Android は base64 で送るため、さらに 1/3 増える。1 件あたり数百バイトで、目安の「数 KB」の内に収まる（この測定は TypeScript の木による推定。Rust の木は fixture で同じ形と確かめている）。
- 結論: 木を付ける方式で payload の増分は小さい。V3 の方式（上）で進める。

## GUI に渡すときの判断（V3 以降）

- 表示データをどこで渡すか（チャットの橋の `ChatItem` に足すか、TypeScript が作り続けるか）は、payload の大きさを測ってから決める。Android は `ChatItem` を base64 の JSON で渡すため、増えた分の影響が大きい。
- `invoke` は一件ごとに呼ばない。表示データはイベントに乗せるか、まとめて一度取る。
- GUI の見た目が変わりうるので、Windows・Linux・Android の実機確認と利用者の確認が要る。

## 既知の差（未検証）

- Markdown の文字の判定（`\p{L}` 相当）は Rust の文字の判定で近似している。結合記号やサロゲートペアの隣の `_` `*` で、JavaScript と違う結果になる可能性がある。
- fixture に無い入力の振る舞いは、両方で一致する保証がない。

## 未決定

1. 表示データを渡す場所（上の「GUI に渡すとき」）。
2. 設定項目の定義をどこに置くか（端末単位・ユーザー単位の境界は [設定のサーバー保管](PLAN_SERVER_SETTINGS.md) と合わせる）。
3. TUI と GUI は同じ版で配る前提でよいか。表示データの形が変わったとき、版がずれた場合の扱い。
