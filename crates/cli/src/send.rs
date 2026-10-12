//! `send` の本文入力と検証。通信結果の分類は core の `SendOutcome` に従う。

use std::io::Read;

/// 本文の最大文字数（サーバーと同じ）。
pub const MAX_BODY_CHARS: usize = 10_000;
/// 標準入力から読むバイト数の上限。巨大な入力でメモリを使い切らない。
const MAX_STDIN_BYTES: u64 = (MAX_BODY_CHARS as u64) * 4 + 4;

#[derive(Debug, PartialEq, Eq)]
pub enum BodyError {
    Empty,
    TooLong,
    InvalidUtf8,
    TerminalStdin,
    Io(String),
}

impl std::fmt::Display for BodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("本文が空です"),
            Self::TooLong => write!(f, "本文は {MAX_BODY_CHARS} 文字までです"),
            Self::InvalidUtf8 => f.write_str("標準入力が UTF-8 ではありません"),
            Self::TerminalStdin => {
                f.write_str("--stdin の入力が端末です。パイプかリダイレクトで本文を渡してください")
            }
            Self::Io(e) => write!(f, "標準入力を読めませんでした: {e}"),
        }
    }
}

/// 標準入力の本文。端末は待たずに拒否し、EOF まで読む。末尾の改行は1個だけ取り除く。
pub fn read_stdin_body(mut input: impl Read, is_terminal: bool) -> Result<String, BodyError> {
    if is_terminal {
        return Err(BodyError::TerminalStdin);
    }
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_STDIN_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| BodyError::Io(e.kind().to_string()))?;
    if bytes.len() as u64 >= MAX_STDIN_BYTES {
        return Err(BodyError::TooLong);
    }
    let mut text = String::from_utf8(bytes).map_err(|_| BodyError::InvalidUtf8)?;
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    validate_body(text)
}

/// 引数または標準入力の本文を送信前に検証する（内部の改行・空白は保持）。
pub fn validate_body(text: String) -> Result<String, BodyError> {
    if text.trim().is_empty() {
        return Err(BodyError::Empty);
    }
    if text.chars().count() > MAX_BODY_CHARS {
        return Err(BodyError::TooLong);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdin_keeps_inner_newlines_and_strips_one_final_newline() {
        assert_eq!(
            read_stdin_body("一行目\n\n三行目\n\n".as_bytes(), false).unwrap(),
            "一行目\n\n三行目\n"
        );
        assert_eq!(read_stdin_body("a\r\n".as_bytes(), false).unwrap(), "a");
        assert_eq!(read_stdin_body("  a  ".as_bytes(), false).unwrap(), "  a  ");
    }

    #[test]
    fn stdin_rejects_terminal_without_reading() {
        struct Fail;
        impl Read for Fail {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                panic!("端末の標準入力を読んではいけない");
            }
        }
        assert_eq!(read_stdin_body(Fail, true), Err(BodyError::TerminalStdin));
    }

    #[test]
    fn rejects_empty_invalid_utf8_and_overlong_bodies() {
        assert_eq!(read_stdin_body("".as_bytes(), false), Err(BodyError::Empty));
        assert_eq!(
            read_stdin_body(" \n\t\n".as_bytes(), false),
            Err(BodyError::Empty)
        );
        assert_eq!(
            read_stdin_body([0xff, 0xfe].as_slice(), false),
            Err(BodyError::InvalidUtf8)
        );
        assert_eq!(
            validate_body("あ".repeat(MAX_BODY_CHARS))
                .unwrap()
                .chars()
                .count(),
            MAX_BODY_CHARS
        );
        assert_eq!(
            validate_body("あ".repeat(MAX_BODY_CHARS + 1)),
            Err(BodyError::TooLong)
        );
        let huge = vec![b'a'; MAX_STDIN_BYTES as usize + 10];
        assert_eq!(
            read_stdin_body(huge.as_slice(), false),
            Err(BodyError::TooLong)
        );
    }
}
