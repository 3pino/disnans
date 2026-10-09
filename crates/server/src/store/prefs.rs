//! user_prefs テーブル（ユーザーごとの設定）。

use sqlx::SqlitePool;

use crate::db;

/// 保存した設定（JSON 文字列）。まだなければ `None`。
pub async fn get(pool: &SqlitePool, user_id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT prefs FROM user_prefs WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

/// 設定をまるごと置き換える。
pub async fn set(pool: &SqlitePool, user_id: &str, prefs: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(prefs)
    .bind(db::now_ms())
    .execute(pool)
    .await?;
    Ok(())
}
