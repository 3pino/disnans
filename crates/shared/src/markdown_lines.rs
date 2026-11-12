//! Markdown の行の判定（サーバーのリンク書き換えとクライアントの木の作り方で同じ。JS の `\s` と trim の空白の範囲）。
//! サーバー（`links.rs`）とクライアント（`view/markdown.rs`）は、これを使う。片方だけ直すと食い違うので、
//! 1 か所に置く。挙動は、以前のクライアントの実装と同じ。

/// JS の `\s`（と trim）が扱う空白
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// JS の trim（上の空白を両端から外す）
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// 行頭の空白（最大 3 つ）と ``` の後ろ（` ```` ` の後）を返す
pub fn fence_rest(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    if spaces > 3 {
        return None;
    }
    line[spaces..].strip_prefix("```")
}

/// `^ {0,3}```\s*([^`\s]*)\s*$` のとき、言語（空なら空文字）
pub fn fence_lang(line: &str) -> Option<&str> {
    let rest = fence_rest(line)?;
    let r = rest.trim_start_matches(is_js_space);
    let end = r
        .find(|c: char| c == '`' || is_js_space(c))
        .unwrap_or(r.len());
    if r[end..].chars().all(is_js_space) {
        Some(&r[..end])
    } else {
        None
    }
}

/// `^ {0,3}```\s*$` のとき（閉じのフェンス）
pub fn is_fence_close(line: &str) -> bool {
    fence_rest(line).is_some_and(|rest| rest.chars().all(is_js_space))
}

/// `^ {0,3}>( ?)(.*)$` のとき、引用の中身（`>` の後の 1 つの空白は除く）。
/// `.` は行末の文字（\n \r \u2028 \u2029）に一致しないので、\u2028・\u2029 を含むと None
pub fn quote_inner(line: &str) -> Option<String> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line[spaces..].strip_prefix('>')?;
    let inner = rest.strip_prefix(' ').unwrap_or(rest);
    if inner.chars().any(|c| matches!(c, '\u{2028}' | '\u{2029}')) {
        return None;
    }
    Some(inner.to_owned())
}

/// タブは 4 桁として数える
pub fn cols_of(ws: &str) -> usize {
    ws.chars().map(|c| if c == '\t' { 4usize } else { 1 }).sum()
}

/// 行頭の空白（空白とタブ）
pub fn indent_of(line: &str) -> &str {
    let len = line
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    &line[..len]
}

/// 行頭から最大 n 桁ぶんの空白を取り除く（タブを途中で切るときは空白にする）
pub fn strip_indent(line: &str, n: usize) -> String {
    let bytes = line.as_bytes();
    let mut col = 0;
    let mut k = 0;
    while k < bytes.len() && col < n {
        match bytes[k] {
            b' ' => col += 1,
            b'\t' => {
                if col + 4 > n {
                    return format!("{}{}", " ".repeat(col + 4 - n), &line[k + 1..]);
                }
                col += 4;
            }
            _ => break,
        }
        k += 1;
    }
    line[k..].to_owned()
}

/// 両側で同じ結果になることを確かめる表（サーバーとクライアントのテストが、同じ表を読む）。
/// `quote` は引用の中身、`fence` は開きのフェンスの言語、`cols` は行頭の空白の桁数。
pub struct LineCase {
    pub line: &'static str,
    pub fence: Option<&'static str>,
    pub close: bool,
    pub quote: Option<&'static str>,
    pub cols: usize,
}

pub const FIXTURES: &[LineCase] = &[
    LineCase {
        line: "```",
        fence: Some(""),
        close: true,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "```rust",
        fence: Some("rust"),
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "   ```  ",
        fence: Some(""),
        close: true,
        quote: None,
        cols: 3,
    },
    LineCase {
        line: "    ```",
        fence: None,
        close: false,
        quote: None,
        cols: 4,
    },
    LineCase {
        line: "```a`b",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "```a b",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "```\u{3000}",
        fence: Some(""),
        close: true,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "```\u{feff}",
        fence: Some(""),
        close: true,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "> quoted",
        fence: None,
        close: false,
        quote: Some("quoted"),
        cols: 0,
    },
    LineCase {
        line: ">  two",
        fence: None,
        close: false,
        quote: Some(" two"),
        cols: 0,
    },
    LineCase {
        line: ">",
        fence: None,
        close: false,
        quote: Some(""),
        cols: 0,
    },
    LineCase {
        line: "    > deep",
        fence: None,
        close: false,
        quote: None,
        cols: 4,
    },
    LineCase {
        line: "a\u{2028}b",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "> a\u{2028}b",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "  \t- item",
        fence: None,
        close: false,
        quote: None,
        cols: 6,
    },
    LineCase {
        line: "\tx",
        fence: None,
        close: false,
        quote: None,
        cols: 4,
    },
    LineCase {
        line: "plain",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    // 境界の文字（JS の \s の範囲）。U+0085 は空白でない、U+FEFF は空白、U+2028 は引用の行で中身にならない
    LineCase {
        line: "```\u{85}",
        fence: Some("\u{85}"),
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "\u{85}```",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "\u{2028}",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
    LineCase {
        line: "> \u{2028}",
        fence: None,
        close: false,
        quote: None,
        cols: 0,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_space_matches_the_js_set() {
        for c in [
            '\t', '\n', ' ', '\u{a0}', '\u{3000}', '\u{feff}', '\u{2028}',
        ] {
            assert!(is_js_space(c), "{c:?}");
        }
        // Rust の is_whitespace は含むが、JS の \s は含まない
        assert!(!is_js_space('\u{85}'));
        assert!(!is_js_space('a'));
        assert_eq!(js_trim("\u{3000} x \u{feff}"), "x");
    }

    #[test]
    fn fixtures_hold_for_the_shared_functions() {
        for case in FIXTURES {
            let line = case.line;
            assert_eq!(fence_lang(line), case.fence, "fence {line:?}");
            assert_eq!(is_fence_close(line), case.close, "close {line:?}");
            assert_eq!(quote_inner(line).as_deref(), case.quote, "quote {line:?}");
            assert_eq!(cols_of(indent_of(line)), case.cols, "cols {line:?}");
        }
    }

    #[test]
    fn strip_indent_splits_tabs() {
        assert_eq!(strip_indent("\tx", 2), "  x");
        assert_eq!(strip_indent("    x", 2), "  x");
        assert_eq!(strip_indent("x", 2), "x");
    }
}
