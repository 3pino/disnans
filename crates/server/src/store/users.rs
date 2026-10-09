//! users テーブル。

use disnans_shared::User;
use sqlx::SqlitePool;

use crate::db;

#[derive(sqlx::FromRow)]
struct UserRow {
    id: String,
    login_name: String,
    display_name: String,
    avatar_url: Option<String>,
    created_at: i64,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        User {
            id: row.id,
            login_name: row.login_name,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            created_at: row.created_at,
        }
    }
}

const COLUMNS: &str = "id, login_name, display_name, avatar_url, created_at";

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<User>> {
    let row: Option<UserRow> = sqlx::query_as(&format!("SELECT {COLUMNS} FROM users WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Into::into))
}

pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<User>> {
    let rows: Vec<UserRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM users ORDER BY created_at, id"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// ログイン名でユーザーを探し、いなければ作る。作った・更新したときは `true` を返す
/// （他のメンバーに `user.updated` を配信するため）。
///
/// 表示名はユーザーが変えられるので、既存のユーザーでは上書きしない。
/// アバターは Tailscale 側の変更に追従する。
pub async fn get_or_create(
    pool: &SqlitePool,
    login_name: &str,
    display_name: &str,
    avatar_url: Option<&str>,
) -> sqlx::Result<(User, bool)> {
    // ほとんどのリクエストは既存のユーザーなので、まず読むだけにする
    if let Some(mut user) = by_login_name(pool, login_name).await? {
        if avatar_url.is_none() || user.avatar_url.as_deref() == avatar_url {
            return Ok((user, false));
        }
        sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ?")
            .bind(avatar_url)
            .bind(&user.id)
            .execute(pool)
            .await?;
        user.avatar_url = avatar_url.map(str::to_owned);
        return Ok((user, true));
    }

    // 同時に作ろうとした場合に備えて、重複は無視する
    let inserted = sqlx::query(
        "INSERT INTO users (id, login_name, display_name, avatar_url, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (login_name) DO NOTHING",
    )
    .bind(db::new_id())
    .bind(login_name)
    .bind(display_name)
    .bind(avatar_url)
    .bind(db::now_ms())
    .execute(pool)
    .await?
    .rows_affected()
        > 0;
    let user = by_login_name(pool, login_name)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok((user, inserted))
}

async fn by_login_name(pool: &SqlitePool, login_name: &str) -> sqlx::Result<Option<User>> {
    let row: Option<UserRow> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM users WHERE login_name = ?"))
            .bind(login_name)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(Into::into))
}

pub async fn update_display_name(
    pool: &SqlitePool,
    id: &str,
    display_name: &str,
) -> sqlx::Result<Option<User>> {
    sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(display_name)
        .bind(id)
        .execute(pool)
        .await?;
    get(pool, id).await
}
