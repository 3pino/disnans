//! plugins テーブル（配布されたプラグイン）。

use disnans_shared::PluginInfo;
use sqlx::{SqliteConnection, SqlitePool};

#[derive(sqlx::FromRow)]
struct PluginRow {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    min_api_version: i64,
    icon: Option<String>,
    /// ファイル名の JSON 配列。
    files: String,
    hash: String,
    updated_by: String,
    updated_at: i64,
}

impl From<PluginRow> for PluginInfo {
    fn from(row: PluginRow) -> Self {
        let files: Vec<String> = serde_json::from_str(&row.files).unwrap_or_default();
        PluginInfo {
            id: row.id,
            name: row.name,
            version: row.version,
            description: row.description,
            author: row.author,
            min_api_version: row.min_api_version.max(0) as u32,
            icon: row.icon,
            has_icon: files.iter().any(|f| f == "icon.svg"),
            files,
            hash: row.hash,
            updated_by: row.updated_by,
            updated_at: row.updated_at,
        }
    }
}

const COLUMNS: &str = "id, name, version, description, author, min_api_version, icon, files, hash, updated_by, updated_at";

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<PluginInfo>> {
    let row: Option<PluginRow> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM plugins WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(Into::into))
}

/// ID 順の一覧。
pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<PluginInfo>> {
    let rows: Vec<PluginRow> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM plugins ORDER BY id"))
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// 追加する。同じ ID があれば上書きする。
pub async fn upsert(conn: &mut SqliteConnection, p: &PluginInfo) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO plugins ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             version = excluded.version,
             description = excluded.description,
             author = excluded.author,
             min_api_version = excluded.min_api_version,
             icon = excluded.icon,
             files = excluded.files,
             hash = excluded.hash,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at"
    ))
    .bind(&p.id)
    .bind(&p.name)
    .bind(&p.version)
    .bind(&p.description)
    .bind(&p.author)
    .bind(i64::from(p.min_api_version))
    .bind(&p.icon)
    .bind(serde_json::to_string(&p.files).unwrap_or_else(|_| "[]".into()))
    .bind(&p.hash)
    .bind(&p.updated_by)
    .bind(p.updated_at)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn delete(conn: &mut SqliteConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM plugins WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
