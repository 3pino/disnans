//! サーバーとクライアントで共有する上限の値。ここが正（サーバーが強制し、クライアントは先に断る）。

/// 本文の最大文字数（サーバーが受ける上限）。
pub const MAX_BODY_CHARS: usize = 10_000;

/// 一時的なイベントの payload（JSON）の最大バイト数。`call.emit` とセッションのイベントで同じ。
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;

/// プラグインのパッケージ（ファイルの合計）の最大バイト数。
pub const MAX_PLUGIN_PACKAGE_BYTES: usize = 5 * 1024 * 1024;

/// 本文の検査の結果の理由（サーバーと CLI はこの順で見る）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyError {
    /// 空または空白だけ（添付がないとき）
    Empty,
    /// `MAX_BODY_CHARS` を超える
    TooLong,
}

/// 本文を検査する。`has_attachments` が真なら、本文が空でもよい（添付だけの投稿）。
/// 空を先に見る。長さは文字数（`chars`）で数える
pub fn validate_body(body: &str, has_attachments: bool) -> Result<(), BodyError> {
    if body.trim().is_empty() && !has_attachments {
        return Err(BodyError::Empty);
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(BodyError::TooLong);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 値を変えたら、サーバー・クライアント・CLI・Tauri の全部に効く。意図した変更かを確かめるため、値を固定する
    #[test]
    fn pinned_values() {
        assert_eq!(MAX_BODY_CHARS, 10_000);
        assert_eq!(MAX_EVENT_PAYLOAD_BYTES, 64 * 1024);
        assert_eq!(MAX_PLUGIN_PACKAGE_BYTES, 5 * 1024 * 1024);
    }
}
