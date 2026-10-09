//! DB の読み書き。テーブルごとにモジュールを分ける。
//!
//! 読み込みは `&SqlitePool`、トランザクションの中で使う書き込みは `&mut SqliteConnection` を受け取る。

pub mod files;
pub mod messages;
pub mod plugins;
pub mod sessions;
pub mod users;

/// ID の一覧を、SQLite の `json_each` で使える JSON 配列の文字列にする。
/// （`WHERE id IN (SELECT value FROM json_each(?))` の形で、可変長の IN を書くため）
fn json_ids(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}
