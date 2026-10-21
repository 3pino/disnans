//! 共有フォルダの名前の決まり（パスの安全さ、Windows で使えない名前）。
//!
//! 書き込みの前に、パスの区切りごとに [`valid_name`] を通す。`..` や `.`、区切りの文字、
//! Windows で使えない文字や予約名（CON・NUL など）は拒否する。

/// 書き込みの途中のファイルの名前の先頭。一覧には出さず、名前としても使わせない。
pub const TMP_PREFIX: &str = ".disnans-tmp-";

/// Windows の予約名（拡張子を付けても予約）。
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Windows で使えない文字（`/` `\` を含む）。
const FORBIDDEN_CHARS: &str = "<>:\"/\\|?*";
const MAX_NAME_BYTES: usize = 255;

/// 作成・改名に使えるひとつの名前か。
pub fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_BYTES || name == "." || name == ".." {
        return false;
    }
    // 内部用の名前（書き込みの途中のファイルなど）は使わせない
    if name.starts_with(".disnans-") {
        return false;
    }
    // 末尾の . と空白、先頭・末尾の空白は Windows で扱えない
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return false;
    }
    if name
        .chars()
        .any(|c| c.is_control() || FORBIDDEN_CHARS.contains(c))
    {
        return false;
    }
    // 拡張子の前の部分が予約名なら、拡張子があっても予約
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !RESERVED.contains(&stem.as_str())
}

/// 一覧から隠す内部用の名前か。
pub fn is_internal(name: &str) -> bool {
    name.starts_with(".disnans-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_are_valid() {
        for n in [
            "a.txt",
            "report 2026.pdf",
            "日本語.png",
            ".bashrc",
            "a",
            "x.tar.gz",
            "中 文",
        ] {
            assert!(valid_name(n), "{n}");
        }
    }

    #[test]
    fn traversal_and_separators_are_refused() {
        for n in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "/etc",
            "..\\x",
            "a\0b",
            "new\nline",
        ] {
            assert!(!valid_name(n), "{n:?}");
        }
    }

    #[test]
    fn windows_unsafe_names_are_refused() {
        for n in [
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "trailing.",
            "trailing ",
            " lead",
            "CON",
            "con.txt",
            "NUL.tar.gz",
            "COM1",
            "lpt9.log",
        ] {
            assert!(!valid_name(n), "{n}");
        }
        // 予約名に似ているが違うもの
        assert!(valid_name("CONTACT.txt"));
        assert!(valid_name("COM10"));
    }

    #[test]
    fn internal_names_and_long_names_are_refused() {
        assert!(!valid_name(".disnans-tmp-01ABC"));
        assert!(is_internal(".disnans-tmp-01ABC"));
        assert!(!is_internal(".hidden"));
        assert!(!valid_name(&"a".repeat(256)));
        assert!(valid_name(&"a".repeat(255)));
    }
}
