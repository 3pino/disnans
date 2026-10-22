//! files テーブル（アップロードされたファイル・`attachments/` の添付）。
//!
//! `file_name` は別名（`attachments/` での名前）。生きている行（`deleted_at` が無い）の中で一意。
//! `library` は投稿せずに `attachments/` の中へ直接作ったもの。`deleted_at` は `attachments/` から消した印。
//! 本体（`data/files/<ID>`）は消した行には無い。

use disnans_shared::Attachment;
use sqlx::{SqliteConnection, SqlitePool};

use super::messages::AttachmentMap;
use crate::attachment_names::key;
use crate::webdav::tree::Item;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FileRow {
    pub id: String,
    pub uploader_id: String,
    pub message_id: Option<String>,
    pub file_name: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_thumb: bool,
    pub library: bool,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
}

impl From<FileRow> for Attachment {
    fn from(row: FileRow) -> Self {
        Attachment {
            id: row.id,
            file_name: row.file_name,
            mime: row.mime,
            size: row.size.max(0) as u64,
            width: row.width.map(|w| w as u32),
            height: row.height.map(|h| h as u32),
            has_thumb: row.has_thumb,
            deleted: row.deleted_at.is_some(),
        }
    }
}

const COLUMNS: &str =
    "id, uploader_id, message_id, file_name, mime, size, width, height, has_thumb,
    library, deleted_at, created_at";

pub async fn insert(pool: &SqlitePool, row: &FileRow) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO files (id, uploader_id, message_id, file_name, alias_key, mime, size, width, height,
                            has_thumb, library, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.uploader_id)
    .bind(&row.message_id)
    .bind(&row.file_name)
    .bind(key(&row.file_name))
    .bind(&row.mime)
    .bind(row.size)
    .bind(row.width)
    .bind(row.height)
    .bind(row.has_thumb)
    .bind(row.library)
    .bind(row.deleted_at)
    .bind(row.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<FileRow>> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM files WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// 生きている添付で、この別名（キー）のもの。
pub async fn live_by_key(pool: &SqlitePool, alias_key: &str) -> sqlx::Result<Option<FileRow>> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM files WHERE alias_key = ? AND deleted_at IS NULL"
    ))
    .bind(alias_key)
    .fetch_optional(pool)
    .await
}

/// メッセージ ID の JSON 配列（→ `super::json_ids`）に対応する添付ファイルを、並び順どおりに返す。
/// 削除された添付も入る（`deleted` が true）。
pub(super) async fn attachments_for(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<AttachmentMap> {
    let rows: Vec<FileRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM files
         WHERE message_id IN (SELECT value FROM json_each(?))
         ORDER BY position, id"
    ))
    .bind(ids_json)
    .fetch_all(pool)
    .await?;

    let mut map = AttachmentMap::new();
    for row in rows {
        let Some(message_id) = row.message_id.clone() else {
            continue;
        };
        map.entry(message_id).or_default().push(row.into());
    }
    Ok(map)
}

/// まだ投稿されていない自分のファイル（または投稿されていない共有の添付）を、メッセージに紐付ける。
/// 紐付けられないファイルがあれば、その ID を `Err` で返す。削除された添付は紐付けられない。
pub async fn attach(
    conn: &mut SqliteConnection,
    file_ids: &[String],
    message_id: &str,
    uploader_id: &str,
) -> sqlx::Result<Result<(), String>> {
    for (position, file_id) in file_ids.iter().enumerate() {
        let updated = sqlx::query(
            "UPDATE files SET message_id = ?, position = ?
             WHERE id = ? AND message_id IS NULL AND deleted_at IS NULL
               AND (uploader_id = ? OR library = 1)",
        )
        .bind(message_id)
        .bind(position as i64)
        .bind(file_id)
        .bind(uploader_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if updated == 0 {
            return Ok(Err(file_id.clone()));
        }
    }
    Ok(Ok(()))
}

/// メッセージに付いているファイルの ID。削除の前に、消すファイルを集めるのに使う。
pub async fn ids_in_message(
    conn: &mut SqliteConnection,
    message_id: &str,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT id FROM files WHERE message_id = ?")
        .bind(message_id)
        .fetch_all(conn)
        .await
}

/// メッセージに付いていて、まだ `attachments/` に見えている添付の別名（変更の通知に使う）。
pub async fn live_names_in_message(
    conn: &mut SqliteConnection,
    message_id: &str,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "SELECT file_name FROM files WHERE message_id = ? AND deleted_at IS NULL ORDER BY position, id",
    )
    .bind(message_id)
    .fetch_all(conn)
    .await
}

/// `before` より前にアップロードされ、まだ投稿されていないファイルの行を消し、その ID を返す。
/// 直接作った添付（`library`）は消さない。
pub async fn delete_orphans(pool: &SqlitePool, before: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "DELETE FROM files WHERE message_id IS NULL AND library = 0 AND created_at < ? RETURNING id",
    )
    .bind(before)
    .fetch_all(pool)
    .await
}

/// `attachments/` に見える添付（投稿されたもの・直接作ったもの。消されていないもの）。
/// 並びは投稿の時刻（直接作ったものは作成の時刻）と ID。
pub async fn attachment_items(pool: &SqlitePool) -> sqlx::Result<Vec<Item>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: String,
        file_name: String,
        size: i64,
        at: i64,
        message_id: Option<String>,
        mime: String,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT f.id AS id, f.file_name AS file_name, f.size AS size,
                COALESCE(m.created_at, f.created_at) AS at, f.message_id AS message_id, f.mime AS mime
         FROM files f LEFT JOIN messages m ON m.id = f.message_id
         WHERE f.deleted_at IS NULL AND (f.message_id IS NOT NULL OR f.library = 1)
         ORDER BY at, f.id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Item {
            file_id: r.id,
            name: r.file_name,
            size: r.size.max(0) as u64,
            posted_at_ms: r.at,
            message_id: r.message_id,
            mime: r.mime,
        })
        .collect())
}

/// 新しい中身（画像の変換後の種類と大きさ）と、今の別名を入れる。
pub struct Content<'a> {
    pub file_name: &'a str,
    pub mime: &'a str,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_thumb: bool,
}

pub async fn set_content(
    conn: &mut SqliteConnection,
    id: &str,
    content: &Content<'_>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE files SET file_name = ?, alias_key = ?, mime = ?, size = ?, width = ?, height = ?,
                          has_thumb = ?
         WHERE id = ?",
    )
    .bind(content.file_name)
    .bind(key(content.file_name))
    .bind(content.mime)
    .bind(content.size)
    .bind(content.width)
    .bind(content.height)
    .bind(content.has_thumb)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

/// 別名だけ変える（ID と中身は同じ）。
pub async fn set_name(conn: &mut SqliteConnection, id: &str, name: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE files SET file_name = ?, alias_key = ? WHERE id = ?")
        .bind(name)
        .bind(key(name))
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// 消した印を付ける（投稿されていた添付。行は残す）。
pub async fn mark_deleted(conn: &mut SqliteConnection, id: &str, now: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE files SET deleted_at = ?, has_thumb = 0 WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// 行ごと消す（だれも参照していない添付）。
pub async fn purge(conn: &mut SqliteConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM files WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
