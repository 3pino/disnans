# 表示データの固定値（fixture）

ステップ8（`.pi/step8-shared-view-model.md`）の共通の表示データを、GUI（TS）と TUI・core（Rust）で同じ結果にするための入出力の例。

- `markdown.json`: 本文の Markdown（`parseInline` / `parse`）、メンションの取り出し・置き換え。
- `mentions.json`: 入力欄の `@名前` ↔ `<@id>`（`bodyToDraft` / `draftToBody`）。
- `continuation.json`: 同じ人の連続（まとめ）の判定。スレッドの条件は含まない。

形式: `schema: 1`。各ケースは `name`・入力・`expected`（期待する出力）。JSON の型は TS の型と同じ形（`type` で判別）。

## 誰が読むか

- TS: `app/src/lib/view/fixtures.test.ts`（vitest。V0 から）。
- Rust: 段 V2 以降、`crates/client-core/tests/` の同じファイルを読む（cargo test。CI のみ）。

## 作り方（V0）

`expected` は、V0 の時点の TS 実装（`app/src/lib/markdown.ts` など）の出力を記録したもの（特徴付け）。人が読んで正しいかを確かめたうえで使う。
後で仕様を変えるときは、`expected` を書き換える前に、変える理由を `.pi/step8-shared-view-model.md` に書く。
