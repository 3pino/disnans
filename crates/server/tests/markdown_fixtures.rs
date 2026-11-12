//! Markdown の行の判定の共有の表（disnans_shared::markdown_lines::FIXTURES）を、このクレートの入口から確かめる。
//! 判定は共有の関数を使うので、表が変わったときに、サーバーとクライアントの両方で同じ結果になることを見る。

use disnans_shared::markdown_lines::{
    FIXTURES, cols_of, fence_lang, indent_of, is_fence_close, quote_inner,
};

#[test]
fn line_rules_match_the_shared_fixtures() {
    for case in FIXTURES {
        let line = case.line;
        assert_eq!(fence_lang(line), case.fence, "fence {line:?}");
        assert_eq!(is_fence_close(line), case.close, "close {line:?}");
        assert_eq!(quote_inner(line).as_deref(), case.quote, "quote {line:?}");
        assert_eq!(cols_of(indent_of(line)), case.cols, "cols {line:?}");
    }
}
