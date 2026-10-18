//! devices / device_prefs テーブル（端末の一覧と、端末ごとの設定）。

use sqlx::{SqliteConnection, SqlitePool};

/// 端末 1 件（一覧の行）。
#[derive(sqlx::FromRow)]
pub struct DeviceRow {
    pub device_id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub has_prefs: bool,
}

/// 自分の端末の一覧（新しい順）。
pub async fn list(pool: &SqlitePool, user_id: &str) -> sqlx::Result<Vec<DeviceRow>> {
    sqlx::query_as(
        "SELECT d.device_id, d.name, d.created_at, d.last_seen_at,
                EXISTS (SELECT 1 FROM device_prefs p
                        WHERE p.user_id = d.user_id AND p.device_id = d.device_id) AS has_prefs
         FROM devices d WHERE d.user_id = ?
         ORDER BY d.created_at DESC, d.device_id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// 端末の数。
pub async fn count(pool: &SqlitePool, user_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
}

/// 1 件（なければ `None`）。
pub async fn get(
    pool: &SqlitePool,
    user_id: &str,
    device_id: &str,
) -> sqlx::Result<Option<DeviceRow>> {
    sqlx::query_as(
        "SELECT d.device_id, d.name, d.created_at, d.last_seen_at,
                EXISTS (SELECT 1 FROM device_prefs p
                        WHERE p.user_id = d.user_id AND p.device_id = d.device_id) AS has_prefs
         FROM devices d WHERE d.user_id = ? AND d.device_id = ?",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_optional(pool)
    .await
}

/// 端末を作る（なければ）、名前を変える。`last_seen_at` も今に更新する。
pub async fn upsert(
    conn: &mut SqliteConnection,
    user_id: &str,
    device_id: &str,
    name: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO devices (user_id, device_id, name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, device_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(name)
    .bind(now)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

/// 端末を消す（設定も一緒に消える）。消したら `true`。
pub async fn delete(pool: &SqlitePool, user_id: &str, device_id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM devices WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// 端末の設定（JSON 文字列と更新時刻）。なければ `None`。
pub async fn prefs_get(
    pool: &SqlitePool,
    user_id: &str,
    device_id: &str,
) -> sqlx::Result<Option<(String, i64)>> {
    sqlx::query_as("SELECT prefs, updated_at FROM device_prefs WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(pool)
        .await
}

/// 設定をまるごと置き換える。端末が登録されていなければ何もせず `false`。
pub async fn prefs_set(
    pool: &SqlitePool,
    user_id: &str,
    device_id: &str,
    prefs: &str,
    now: i64,
) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "INSERT INTO device_prefs (user_id, device_id, prefs, updated_at)
         SELECT ?, ?, ?, ? FROM devices WHERE user_id = ? AND device_id = ?
         ON CONFLICT (user_id, device_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(prefs)
    .bind(now)
    .bind(user_id)
    .bind(device_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// 最後に使った時刻を今にする。
pub async fn touch(
    pool: &SqlitePool,
    user_id: &str,
    device_id: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?")
        .bind(now)
        .bind(user_id)
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}
