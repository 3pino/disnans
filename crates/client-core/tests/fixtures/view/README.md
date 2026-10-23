# 表示データの固定値（fixture）

共通の表示データ（[docs/DESIGN.md](../../../../../docs/DESIGN.md#クライアントと共通表示データ)）を、GUI（TS）と TUI・core（Rust）で同じ結果にするための入出力の例。

- `markdown.json`: 本文の Markdown の木（`parse_inline` / `parse` の期待値。Rust が唯一の実装）、メンションの置き換え（`mentionsToText`）、メンションの取り出し（Rust の `extract_mentions`）。
- `mentions.json`: 入力欄の `@名前` ↔ `<@id>`（`bodyToDraft` / `draftToBody`）。
- `continuation.json`: 同じ人の連続（まとめ）の判定。スレッドの条件は含まない。

形式: `schema: 1`。各ケースは `name`・入力・`expected`（期待する出力）。JSON の型は TS の型と同じ形（`type` で判別）。

## 誰が読むか

- TS: `app/src/lib/view/fixtures.test.ts`（vitest）。段 A 以降、木の値は Rust に任せ、TS は木の形（描画が扱える型）と、メンションの置き換え・入力欄・続きの判定を見る。
- Rust: `crates/client-core/tests/view_fixtures.rs`（`scripts/check-rust.sh` で走る）。木の値の正は、ここ。

## 作り方（V0）

`expected` は、V0 の時点の TS 実装の出力を記録したもの（特徴付け）。段 A で TS の Markdown 解析を消す前に、旧 TS の出力を `markdown.test.ts` の入力から記録して加えた（`ported_*` の名前）。その時点で Rust の木は全件一致した。
人が読んで正しいかを確かめたうえで使う。
後で仕様を変えるときは、`expected` を書き換える前に、変える理由を、その PR・コミットのメッセージか `docs/DESIGN.md` に書く。
