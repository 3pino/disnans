//! サーバー由来・入力由来の文字列を、端末に制御列として解釈させずに表示する。

use unicode_width::UnicodeWidthChar;

/// 表示に使う文字へ変換する。`keep_newline` が偽なら改行も `\n` として1行に収める。
///
/// - 改行は（保持するなら）`\n` に統一する（`\r\n` も1つの改行）。
/// - タブは空白4つ。
/// - ESC を含む C0/C1/DEL、行区切り、ゼロ幅スペース、双方向制御は `\u{XX}` に見える形にする。
///   バックスラッシュ自体は変えない（チャット本文のパスなどを壊さない）。
pub fn escape_text(input: &str, keep_newline: bool) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {}
            '\r' | '\n' => {
                if keep_newline {
                    out.push('\n');
                } else {
                    out.push_str("\\n");
                }
            }
            '\t' => out.push_str("    "),
            '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '\u{200b}'
            | '\u{200e}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'
            | '\u{2066}'..='\u{2069}'
            | '\u{feff}' => out.push_str(&format!("\\u{{{:X}}}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

/// 1行の表示用（名前・理由など）。
pub fn inline(input: &str) -> String {
    escape_text(input, false)
}

/// 本文用。改行ごとに行へ分ける。
pub fn body_lines(input: &str) -> Vec<String> {
    escape_text(input, true)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

pub fn char_width(c: char) -> usize {
    c.width().unwrap_or(0)
}

pub fn display_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

/// 表示幅 `width` 桁以内の行へ折り返す。できれば直前の空白で切る。
/// 空の入力は空行1つを返す。
pub fn wrap(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut current: Vec<(char, usize)> = Vec::new();
    let mut used = 0;
    for c in line.chars() {
        let w = char_width(c);
        if used + w > width && !current.is_empty() {
            // 溢れたのが空白なら、そこで行を終えて空白は捨てる。
            if c == ' ' {
                rows.push(trim_end(&current));
                current.clear();
                used = 0;
                continue;
            }
            // 直前の空白で切れるなら、その後ろを次の行へ持ち越す。
            let split = current.iter().rposition(|(ch, _)| *ch == ' ').filter(|i| {
                *i + 1 < current.len() && current[..=*i].iter().any(|(c, _)| *c != ' ')
            });
            let rest = match split {
                Some(i) => current.split_off(i + 1),
                None => Vec::new(),
            };
            rows.push(trim_end(&current));
            current = rest;
            used = current.iter().map(|(_, w)| w).sum();
        }
        current.push((c, w));
        used += w;
    }
    rows.push(current.iter().map(|(c, _)| *c).collect());
    rows
}

fn trim_end(chars: &[(char, usize)]) -> String {
    let text: String = chars.iter().map(|(c, _)| *c).collect();
    text.trim_end_matches(' ').to_owned()
}

/// 表示幅 `max` 桁に収まるよう末尾を `…` で省く。
pub fn truncate(text: &str, max: usize) -> String {
    if display_width(text) <= max {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = char_width(c);
        if used + w + 1 > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_control_sequences_become_visible_text() {
        let escaped = inline("a\u{1b}[2Jb\u{9b}c\u{202e}d\u{7f}\u{200b}\u{feff}e\r\nf\rg");
        assert!(!escaped.chars().any(|c| c.is_control()), "{escaped:?}");
        assert!(escaped.contains("\\u{1B}[2J"));
        assert!(escaped.contains("\\u{9B}"));
        assert!(escaped.contains("\\u{202E}"));
        assert!(escaped.contains("\\u{7F}"));
        assert!(escaped.contains("\\u{200B}"));
        assert!(escaped.contains("\\u{FEFF}"));
        assert_eq!(inline("x\r\ny\rz\nw"), "x\\ny\\nz\\nw");
    }

    #[test]
    fn newlines_are_kept_only_when_asked_and_tabs_become_spaces() {
        assert_eq!(body_lines("a\r\nb\rc\n\nd"), ["a", "b", "c", "", "d"]);
        assert_eq!(inline("a\tb"), "a    b");
        assert_eq!(inline("C:\\tmp\\x"), "C:\\tmp\\x");
        assert_eq!(body_lines(""), [""]);
    }

    #[test]
    fn no_escaped_text_contains_a_raw_control_even_with_keep_newline() {
        for line in body_lines("\u{1b}]0;title\u{7}\u{85}text\u{2028}") {
            assert!(!line.chars().any(|c| c.is_control()), "{line:?}");
        }
    }

    #[test]
    fn wide_characters_wrap_by_display_width() {
        assert_eq!(wrap("あいうえお", 4), ["あい", "うえ", "お"]);
        // 幅2の文字が1桁に入らなくても無限ループしない。
        assert_eq!(wrap("あい", 1), ["あ", "い"]);
        for row in wrap("日本語のテキストを折り返す abc def", 7) {
            assert!(display_width(&row) <= 7, "{row:?}");
        }
    }

    #[test]
    fn wraps_at_spaces_when_possible_and_keeps_all_text() {
        assert_eq!(wrap("hello world foo", 11), ["hello world", "foo"]);
        assert_eq!(wrap("hello world", 8), ["hello", "world"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("", 10), [""]);
        let rows = wrap("a b c d e f g h", 3);
        assert_eq!(rows.join(" "), "a b c d e f g h");
    }

    #[test]
    fn combining_marks_stay_with_their_base() {
        let text = "e\u{301}e\u{301}e\u{301}";
        assert_eq!(display_width(text), 3);
        assert_eq!(wrap(text, 3), [text]);
    }

    #[test]
    fn truncate_respects_display_width() {
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("あいう", 5), "あい…");
        assert_eq!(truncate("ab", 5), "ab");
    }
}
