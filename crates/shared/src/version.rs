//! バージョン番号の比較（サーバーの自動更新と CLI の更新で同じ）。semver に従う。
//! 例: `1.2.4-rc.1` は `1.2.3` より新しく、`1.2.4` より古い。`1.2.3+build` は `1.2.3` と同じ。

use semver::Version;

/// `1.2.3` / `v1.2.3` / `1.2.3-rc.1` を読む（前後の空白と先頭の `v` は外す）。読めなければ None。
pub fn parse(text: &str) -> Option<Version> {
    let text = text.trim();
    Version::parse(text.strip_prefix('v').unwrap_or(text)).ok()
}

/// `candidate` が `current` より新しいか。どちらかが読めなければ None（比べられない）。
/// ビルドの情報（`+build`）は順を決めない（semver の決まり）。
pub fn is_newer(candidate: &str, current: &str) -> Option<bool> {
    Some(parse(candidate)?.cmp_precedence(&parse(current)?).is_gt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_and_v_prefixed_versions() {
        assert_eq!(parse("v0.2.18"), Version::parse("0.2.18").ok());
        assert_eq!(parse(" 1.10.0 "), Version::parse("1.10.0").ok());
        assert!(parse("1.2").is_none());
        assert!(parse("1.2.3.4").is_none());
        assert!(parse("garbage").is_none());
    }

    #[test]
    fn compares_numbers_not_text() {
        assert_eq!(is_newer("0.2.18", "0.2.17"), Some(true));
        assert_eq!(is_newer("v0.10.0", "0.9.9"), Some(true));
        assert_eq!(is_newer("0.2.10", "0.2.9"), Some(true));
        assert_eq!(is_newer("0.2.7", "0.2.7"), Some(false), "同じ版は入れない");
        assert_eq!(is_newer("0.2.16", "0.2.17"), Some(false), "下げない");
        assert_eq!(is_newer("x", "0.2.0"), None);
        assert_eq!(is_newer("0.2.0", "y"), None);
    }

    /// 以前は、サーバーと CLI で結果が違った入力（プレリリースの扱い）。今は semver の順に統一する
    #[test]
    fn prereleases_follow_semver_order() {
        // 次の版のプレリリースは、いまの版より新しく、次の版の正式版より古い
        assert_eq!(is_newer("1.2.4-rc.1", "1.2.3"), Some(true));
        assert_eq!(is_newer("1.2.4-rc.1", "1.2.4"), Some(false));
        assert_eq!(is_newer("1.2.4", "1.2.4-rc.1"), Some(true));
        // 同じ版の正式版は、そのプレリリースより新しい（以前の CLI は同じ扱いで false だった）
        assert_eq!(is_newer("1.2.3", "1.2.3-rc.1"), Some(true));
        assert_eq!(is_newer("1.2.3-rc.1", "1.2.3"), Some(false));
        assert_eq!(is_newer("v0.3.0-rc.1", "0.2.17"), Some(true));
        // ビルドの情報は版の順に効かない
        assert_eq!(is_newer("1.2.3+build", "1.2.3"), Some(false));
    }
}
