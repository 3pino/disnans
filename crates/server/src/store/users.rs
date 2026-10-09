//! users テーブル。

use disnans_shared::User;
use sqlx::SqlitePool;

use crate::db;

#[derive(sqlx::FromRow)]
struct UserRow {
    id: String,
    login_name: String,
    display_name: String,
    /// Tailscale のプロフィール画像の URL。
    avatar_url: Option<String>,
    /// 自分で設定したアバターのファイル ID。
    avatar_file: Option<String>,
    created_at: i64,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        User {
            avatar_url: match &row.avatar_file {
                Some(file) => Some(avatar_path(file)),
                None => row.avatar_url,
            },
            id: row.id,
            login_name: row.login_name,
            display_name: row.display_name,
            created_at: row.created_at,
        }
    }
}

const COLUMNS: &str = "id, login_name, display_name, avatar_url, avatar_file, created_at";

/// 自分で設定したアバターの URL（サーバーからの相対パス）。
pub fn avatar_path(file: &str) -> String {
    format!("/api/avatars/{file}")
}

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
/// Tailscale のプロフィール画像の URL は Tailscale 側の変更に追従して覚えておくが、
/// 自分でアバターを設定しているあいだは、そちらを表示に使う（変わったことにしない）。
pub async fn get_or_create(
    pool: &SqlitePool,
    login_name: &str,
    display_name: &str,
    avatar_url: Option<&str>,
) -> sqlx::Result<(User, bool)> {
    // ほとんどのリクエストは既存のユーザーなので、まず読むだけにする
    if let Some(row) = row_by_login_name(pool, login_name).await? {
        if avatar_url.is_none() || row.avatar_url.as_deref() == avatar_url {
            return Ok((row.into(), false));
        }
        sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ?")
            .bind(avatar_url)
            .bind(&row.id)
            .execute(pool)
            .await?;
        let shown_changed = row.avatar_file.is_none();
        let mut user: User = row.into();
        if shown_changed {
            user.avatar_url = avatar_url.map(str::to_owned);
        }
        return Ok((user, shown_changed));
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
    Ok(row_by_login_name(pool, login_name).await?.map(Into::into))
}

async fn row_by_login_name(pool: &SqlitePool, login_name: &str) -> sqlx::Result<Option<UserRow>> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM users WHERE login_name = ?"))
        .bind(login_name)
        .fetch_optional(pool)
        .await
}

/// 自分で設定したアバターのファイル ID。
pub async fn avatar_file(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<String>> {
    let file: Option<Option<String>> =
        sqlx::query_scalar("SELECT avatar_file FROM users WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(file.flatten())
}

/// アバターのファイル ID を差し替える（`None` で Tailscale のプロフィール画像に戻す）。
pub async fn set_avatar_file(
    pool: &SqlitePool,
    id: &str,
    file: Option<&str>,
) -> sqlx::Result<Option<User>> {
    sqlx::query("UPDATE users SET avatar_file = ? WHERE id = ?")
        .bind(file)
        .bind(id)
        .execute(pool)
        .await?;
    get(pool, id).await
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
