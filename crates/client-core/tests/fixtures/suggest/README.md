# 補完の規則の fixture

入力欄の補完（`@` のメンバー、`:` の絵文字、行頭の `/` のコマンド名）の規則を、GUI（TS）と core（Rust・TUI）で同じ結果にするための入出力の例。

- `mention.json`（`@`）、`emoji.json`（`:`）、`slash.json`（`/`）、`order.json`（出どころの順と、候補が無いときの次への落ち方）。
- 入力は `before`（キャレットより前の文字列）と、ファイルごとの `members`（利用者）・`commands`（名前と説明）。
- 期待値 `expected` は、置き換える部分（`replaced`）・検索語（`query`）・候補（`key` / `title` / `insert`）。`null` は何も出さないこと。

## 誰が読むか

- GUI: `app/src/lib/suggest/fixtures.test.ts`（GUI の providers の順 slash → mention → emoji で確かめる）。
- Rust: `crates/client-core/tests/suggest_fixtures.rs`（`view::suggest::detect`）。

## 作り方と変え方

`expected` は、この fixture を作ったときの GUI の出力を記録し、人が読んで正しいと確かめたもの（特徴付け）。
規則を変えるときは、先に `expected` を書き換えない。変える理由を `docs/design/architecture.md` かコミットに書いてから、GUI と core を両方直す。
絵文字の表（名前の並び）は `view/emoji.rs` が正で、GUI の `emojiNames.generated.ts` は生成物。fixture には表を入れない。
