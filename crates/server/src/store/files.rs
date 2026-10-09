//! files テーブル（アップロードされたファイル）。

use disnans_shared::Attachment;
use sqlx::{SqliteConnection, SqlitePool};

use super::messages::AttachmentMap;

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
        }
    }
}

const COLUMNS: &str =
    "id, uploader_id, message_id, file_name, mime, size, width, height, has_thumb, created_at";

pub async fn insert(pool: &SqlitePool, row: &FileRow) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO files ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&row.id)
    .bind(&row.uploader_id)
    .bind(&row.message_id)
    .bind(&row.file_name)
    .bind(&row.mime)
    .bind(row.size)
    .bind(row.width)
    .bind(row.height)
    .bind(row.has_thumb)
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

/// メッセージ ID の JSON 配列（→ `super::json_ids`）に対応する添付ファイルを、並び順どおりに返す。
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

/// まだ投稿されていない自分のファイルを、メッセージに紐付ける。
/// 紐付けられないファイルがあれば、その ID を `Err` で返す。
pub async fn attach(
    conn: &mut SqliteConnection,
    file_ids: &[String],
    message_id: &str,
    uploader_id: &str,
) -> sqlx::Result<Result<(), String>> {
    for (position, file_id) in file_ids.iter().enumerate() {
        let updated = sqlx::query(
            "UPDATE files SET message_id = ?, position = ?
             WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
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

/// メッセージ（とスレッドの返信）に付いているファイルの ID。削除の前に、消すファイルを集めるのに使う。
pub async fn ids_in_message_tree(
    conn: &mut SqliteConnection,
    message_id: &str,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(
        "SELECT id FROM files
         WHERE message_id = ? OR message_id IN (SELECT id FROM messages WHERE thread_id = ?)",
    )
    .bind(message_id)
    .bind(message_id)
    .fetch_all(conn)
    .await
}

/// `before` より前にアップロードされ、まだ投稿されていないファイルの行を消し、その ID を返す。
pub async fn delete_orphans(pool: &SqlitePool, before: i64) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("DELETE FROM files WHERE message_id IS NULL AND created_at < ? RETURNING id")
        .bind(before)
        .fetch_all(pool)
        .await
}
