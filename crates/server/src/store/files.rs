//! files テーブル（アップロードされたファイル・`attachments/` の添付）。
//!
//! `file_name` は別名（`attachments/` での名前）。生きている行（`deleted_at` が無い）の中で一意。
//! `library` は投稿せずに `attachments/` の中へ直接作ったもの。`deleted_at` は `attachments/` から消した印。
//! 本体（`data/files/<ID>`）は消した行には無い。

use std::collections::HashMap;

use disnans_shared::Attachment;
use sqlx::{SqliteConnection, SqlitePool};

use super::messages::AttachmentMap;
use crate::attachment_names::key;
use crate::links;
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
    pub first_posted_at: Option<i64>,
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
    library, deleted_at, first_posted_at, created_at";

pub async fn insert(pool: &SqlitePool, row: &FileRow) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO files (id, uploader_id, message_id, file_name, alias_key, mime, size, width, height,
                            has_thumb, library, deleted_at, first_posted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(row.first_posted_at)
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

/// 本文ごとの添付（本文のリンクの順）。`rows` は (メッセージ ID, 本文)。削除された添付も入る（`deleted` が true）。
/// 本文に無い添付は入らない（本文が真実）。
pub(super) async fn attachments_for_bodies(
    pool: &SqlitePool,
    rows: &[(String, String)],
) -> sqlx::Result<AttachmentMap> {
    let mut wanted: Vec<Vec<String>> = Vec::new();
    let mut all: Vec<String> = Vec::new();
    for (_, body) in rows {
        let ids = links::ids_in(body);
        for id in &ids {
            if !all.contains(id) {
                all.push(id.clone());
            }
        }
        wanted.push(ids);
    }
    let mut by_id: HashMap<String, FileRow> = HashMap::new();
    if !all.is_empty() {
        let found: Vec<FileRow> = sqlx::query_as(&format!(
            "SELECT {COLUMNS} FROM files WHERE id IN (SELECT value FROM json_each(?))"
        ))
        .bind(serde_json::to_string(&all).unwrap_or_else(|_| "[]".into()))
        .fetch_all(pool)
        .await?;
        by_id = found.into_iter().map(|r| (r.id.clone(), r)).collect();
    }

    let mut map = AttachmentMap::new();
    for ((message_id, _), ids) in rows.iter().zip(wanted) {
        let list: Vec<Attachment> = ids
            .iter()
            .filter_map(|id| by_id.get(id).cloned())
            .map(Attachment::from)
            .collect();
        if !list.is_empty() {
            map.insert(message_id.clone(), list);
        }
    }
    Ok(map)
}

/// 本文の添付の行（削除された添付も含む）。`message_id` が NULL のものも ID で探す。
pub async fn rows_by_ids(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> sqlx::Result<Vec<FileRow>> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM files WHERE id IN (SELECT value FROM json_each(?))"
    ))
    .bind(serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()))
    .fetch_all(conn)
    .await
}

/// 本文に添付を付ける（送信・編集・bot の投稿）。`ids` は、その本文が参照する添付（順番どおり）。
/// `fresh` は添付の欄（`attachment_ids`）から来たもの: 投稿されていない自分のもの（または `library`）だけ。
/// それ以外は、生きている添付（投稿済み・`library`）を参照できる。
/// 付けられない ID が一つでもあれば、その ID を `Some` で返す（何も書かない前提で呼び出し側が止める）。
/// 紐付けは、まだ無ければ今のメッセージに（初回の紐付けの時刻も今）。
pub async fn claim(
    conn: &mut SqliteConnection,
    ids: &[String],
    fresh: &[String],
    message_id: &str,
    uploader_id: &str,
    now: i64,
) -> sqlx::Result<Option<String>> {
    for id in ids {
        let row: Option<(Option<String>, Option<i64>, bool, String)> = sqlx::query_as(
            "SELECT message_id, deleted_at, library, uploader_id FROM files WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((posted, deleted_at, library, uploader)) = row else {
            return Ok(Some(id.clone()));
        };
        if deleted_at.is_some() {
            return Ok(Some(id.clone()));
        }
        let ok = if fresh.contains(id) {
            posted.is_none() && (uploader == uploader_id || library)
        } else {
            // 本文の参照: 投稿済み・library・自分の未投稿（送信者が本文の `![[…]]` から参照できる）
            posted.is_some() || library || uploader == uploader_id
        };
        if !ok {
            return Ok(Some(id.clone()));
        }
        sqlx::query(
            "UPDATE files SET message_id = COALESCE(message_id, ?), first_posted_at = COALESCE(first_posted_at, ?)
             WHERE id = ?",
        )
        .bind(message_id)
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(None)
}

/// 本文が `id` を参照している、ほかのメッセージ（古い順に最初の一件）。`exclude` は数えない。
pub async fn referencing_message(
    conn: &mut SqliteConnection,
    id: &str,
    exclude: Option<&str>,
) -> sqlx::Result<Option<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, body FROM messages WHERE instr(body, ?) > 0 AND id IS NOT ? ORDER BY created_at, id",
    )
    .bind(format!("{}{id}", links::ID_PREFIX))
    .bind(exclude)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .find(|(_, body)| links::ids_in(body).iter().any(|i| i == id))
        .map(|(message, _)| message))
}

/// 本文から外れた添付（`message` の本文からリンクが消えた、またはメッセージが消えた）の後始末。
pub enum Unlinked {
    /// ほかの本文にまだある。紐付けを移した（または変わらない）。
    Moved,
    /// どの本文にも無い。投稿されていた生きた添付は `attachments/` に残した（`library`）。
    Kept,
    /// 行を消した。`name` は消す前の別名（生きていた添付だけ `attachments/` から消える）。
    Purged { name: Option<String> },
}

/// `message` の本文から `id` が外れたあとで呼ぶ（本文はもう書き換えてあること）。
/// `keep_live`: 生きた添付をどの本文にも無いとき残すか（編集は残す、メッセージの削除は消す）。
/// 消された添付（tombstone）は、どの本文にも無ければ行を消す。
pub async fn unlink(
    conn: &mut SqliteConnection,
    id: &str,
    message: &str,
    keep_live: bool,
) -> sqlx::Result<Unlinked> {
    if let Some(other) = referencing_message(conn, id, Some(message)).await? {
        sqlx::query("UPDATE files SET message_id = ? WHERE id = ? AND message_id = ?")
            .bind(other)
            .bind(id)
            .bind(message)
            .execute(&mut *conn)
            .await?;
        return Ok(Unlinked::Moved);
    }
    let row: Option<(Option<i64>, String)> =
        sqlx::query_as("SELECT deleted_at, file_name FROM files WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((deleted_at, name)) = row else {
        return Ok(Unlinked::Purged { name: None });
    };
    if deleted_at.is_none() && keep_live {
        sqlx::query("UPDATE files SET message_id = NULL, library = 1 WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
        return Ok(Unlinked::Kept);
    }
    purge(conn, id).await?;
    Ok(Unlinked::Purged {
        name: deleted_at.is_none().then_some(name),
    })
}

/// メッセージに紐付いている（`message_id`）ファイルの ID。
pub async fn ids_with_message(
    conn: &mut SqliteConnection,
    message_id: &str,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT id FROM files WHERE message_id = ?")
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
                COALESCE(f.first_posted_at, f.created_at) AS at, f.message_id AS message_id, f.mime AS mime
         FROM files f
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
