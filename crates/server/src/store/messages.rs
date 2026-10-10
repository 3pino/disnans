//! messages / threads / reactions テーブル。
//!
//! `Message` は添付ファイル・リアクション・スレッド・カードの情報をまとめて組み立てる。

use std::collections::HashMap;

use disnans_shared::{
    Attachment, BotInfo, Message, Reaction, ReplyPreview, Thread, ThreadInfo, ThreadTag,
    ThreadTagUsage,
};
use sqlx::{SqliteConnection, SqlitePool};

use super::{files, json_ids, sessions};

/// messages テーブルの1行（添付ファイルなどを含まない）。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageRow {
    pub id: String,
    pub author_id: String,
    pub thread_id: Option<String>,
    pub reply_to: Option<String>,
    pub body: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub bot_plugin: Option<String>,
    pub bot_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ThreadRow {
    id: String,
    reply_count: i64,
    last_reply_at: Option<i64>,
    created_by: String,
    title: Option<String>,
    archived: bool,
}

#[derive(sqlx::FromRow)]
struct ReplyRow {
    id: String,
    author_id: String,
    body: String,
    bot_plugin: Option<String>,
    bot_name: Option<String>,
    has_attachments: bool,
}

/// 返信先の要約に入れる本文の最大文字数。
const PREVIEW_CHARS: usize = 100;

#[derive(sqlx::FromRow)]
struct ReactionRow {
    message_id: String,
    emoji: String,
    user_id: String,
}

const COLUMNS: &str =
    "id, author_id, thread_id, reply_to, body, created_at, edited_at, bot_plugin, bot_name";

// ---- 読み込み ----

pub async fn get_row(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<MessageRow>> {
    sqlx::query_as(&format!("SELECT {COLUMNS} FROM messages WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Message>> {
    Ok(load(pool, &[id.to_owned()]).await?.pop())
}

/// 指定した ID のメッセージを、添付ファイルなどを含めて組み立てる。
/// 返す順番は `ids` の順。見つからないものは飛ばす。
pub async fn load(pool: &SqlitePool, ids: &[String]) -> sqlx::Result<Vec<Message>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_json = json_ids(ids);

    let rows: Vec<MessageRow> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM messages WHERE id IN (SELECT value FROM json_each(?))"
    ))
    .bind(&ids_json)
    .fetch_all(pool)
    .await?;

    let mut attachments = files::attachments_for(pool, &ids_json).await?;
    let mut reactions = reactions_for(pool, &ids_json).await?;
    let mut threads = thread_infos_for(pool, &ids_json).await?;
    let mut cards = sessions::cards_for(pool, &ids_json).await?;
    let mut previews = reply_previews_for(pool, &rows).await?;

    let mut by_id: HashMap<String, MessageRow> =
        rows.into_iter().map(|r| (r.id.clone(), r)).collect();
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .map(|row| Message {
            attachments: attachments.remove(&row.id).unwrap_or_default(),
            reactions: reactions.remove(&row.id).unwrap_or_default(),
            thread: threads.remove(&row.id),
            card: cards.remove(&row.id),
            bot: row
                .bot_plugin
                .zip(row.bot_name)
                .map(|(plugin, name)| BotInfo { plugin, name }),
            id: row.id,
            author_id: row.author_id,
            thread_id: row.thread_id,
            reply_preview: row.reply_to.as_ref().and_then(|to| previews.remove(to)),
            reply_to: row.reply_to,
            body: row.body,
            created_at: row.created_at,
            edited_at: row.edited_at,
        })
        .collect())
}

/// 本文の全文検索。空白で区切った語をすべて含むメッセージを、`before` より古いものから新しい順に最大 `limit` 件返す。
/// メインチャットもスレッドの返信も対象にする（`thread_id` で、どこのメッセージかわかる）。
pub async fn search(
    pool: &SqlitePool,
    query: &str,
    before: Option<&str>,
    limit: u32,
) -> sqlx::Result<Vec<Message>> {
    let ids = search_ids(pool, query, before, limit).await?;
    load(pool, &ids).await
}

/// 検索に一致するメッセージの ID（新しい順）。
async fn search_ids(
    pool: &SqlitePool,
    query: &str,
    before: Option<&str>,
    limit: u32,
) -> sqlx::Result<Vec<String>> {
    let terms: Vec<&str> = query.split_whitespace().collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    // trigram の索引は 3 文字以上の語でしか引けない。短い語を含むときは LIKE で探す（遅いが、件数は多くない）
    if terms.iter().all(|t| t.chars().count() >= 3) {
        // 語ごとにフレーズにして、AND でつなぐ（フレーズ内の二重引用符は二つに直す）
        let expr = terms
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM messages
             WHERE id IN (SELECT id FROM messages_fts WHERE messages_fts MATCH ?)
               AND (? IS NULL OR id < ?)
             ORDER BY id DESC
             LIMIT ?",
        )
        .bind(expr)
        .bind(before)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        return Ok(ids);
    }

    let conds = vec!["body LIKE ? ESCAPE '\\'"; terms.len()].join(" AND ");
    let sql = format!(
        "SELECT id FROM messages
         WHERE {conds} AND (? IS NULL OR id < ?)
         ORDER BY id DESC
         LIMIT ?"
    );
    let mut q = sqlx::query_scalar::<_, String>(&sql);
    for term in &terms {
        q = q.bind(format!("%{}%", escape_like(term)));
    }
    q.bind(before)
        .bind(before)
        .bind(limit)
        .fetch_all(pool)
        .await
}

/// LIKE のワイルドカード（`%` `_`）と、エスケープの `\` を文字として扱えるようにする。
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// メインチャット（`thread_id` が `None`）またはスレッドの返信を、`before` より古いものから
/// 新しい順に最大 `limit` 件取り、古い順に並べて返す。
pub async fn page(
    pool: &SqlitePool,
    thread_id: Option<&str>,
    before: Option<&str>,
    limit: u32,
) -> sqlx::Result<Vec<Message>> {
    let mut ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM messages
         WHERE thread_id IS ? AND (? IS NULL OR id < ?)
         ORDER BY id DESC
         LIMIT ?",
    )
    .bind(thread_id)
    .bind(before)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    ids.reverse();
    load(pool, &ids).await
}

/// メッセージごとのリアクション。絵文字は最初に付けられた順、ユーザーも付けた順に並べる。
async fn reactions_for(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<HashMap<String, Vec<Reaction>>> {
    let rows: Vec<ReactionRow> = sqlx::query_as(
        "SELECT message_id, emoji, user_id FROM reactions
         WHERE message_id IN (SELECT value FROM json_each(?))
         ORDER BY created_at, rowid",
    )
    .bind(ids_json)
    .fetch_all(pool)
    .await?;

    let mut map: HashMap<String, Vec<Reaction>> = HashMap::new();
    for row in rows {
        let list = map.entry(row.message_id).or_default();
        match list.iter_mut().find(|r| r.emoji == row.emoji) {
            Some(reaction) => reaction.user_ids.push(row.user_id),
            None => list.push(Reaction {
                emoji: row.emoji,
                user_ids: vec![row.user_id],
            }),
        }
    }
    Ok(map)
}

pub async fn reactions(pool: &SqlitePool, message_id: &str) -> sqlx::Result<Vec<Reaction>> {
    let mut map = reactions_for(pool, &json_ids(&[message_id.to_owned()])).await?;
    Ok(map.remove(message_id).unwrap_or_default())
}

/// 返信の返信先の要約。返信先が消えていれば入らない。
async fn reply_previews_for(
    pool: &SqlitePool,
    rows: &[MessageRow],
) -> sqlx::Result<HashMap<String, ReplyPreview>> {
    let targets: Vec<String> = rows.iter().filter_map(|r| r.reply_to.clone()).collect();
    if targets.is_empty() {
        return Ok(HashMap::new());
    }
    let found: Vec<ReplyRow> = sqlx::query_as(
        "SELECT m.id, m.author_id, m.body, m.bot_plugin, m.bot_name,
                EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id) AS has_attachments
         FROM messages m
         WHERE m.id IN (SELECT value FROM json_each(?))",
    )
    .bind(json_ids(&targets))
    .fetch_all(pool)
    .await?;
    Ok(found
        .into_iter()
        .map(|r| {
            let text = r.body.split_whitespace().collect::<Vec<_>>().join(" ");
            let body = if text.chars().count() > PREVIEW_CHARS {
                let mut cut: String = text.chars().take(PREVIEW_CHARS).collect();
                cut.push('…');
                cut
            } else {
                text
            };
            (
                r.id,
                ReplyPreview {
                    author_id: r.author_id,
                    body,
                    has_attachments: r.has_attachments,
                    bot: r
                        .bot_plugin
                        .zip(r.bot_name)
                        .map(|(plugin, name)| BotInfo { plugin, name }),
                },
            )
        })
        .collect())
}

async fn thread_infos_for(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<HashMap<String, ThreadInfo>> {
    let rows: Vec<ThreadRow> = sqlx::query_as(
        "SELECT t.id,
                (SELECT COUNT(*) FROM messages r WHERE r.thread_id = t.id) AS reply_count,
                (SELECT MAX(r.created_at) FROM messages r WHERE r.thread_id = t.id) AS last_reply_at,
                COALESCE(t.created_by, m.author_id) AS created_by,
                t.title, t.archived
         FROM threads t
         JOIN messages m ON m.id = t.id
         WHERE t.id IN (SELECT value FROM json_each(?))",
    )
    .bind(ids_json)
    .fetch_all(pool)
    .await?;

    let mut tags = tags_for(pool, ids_json).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.id.clone(),
                ThreadInfo {
                    reply_count: row.reply_count as u32,
                    last_reply_at: row.last_reply_at,
                    created_by: row.created_by,
                    title: row.title,
                    tags: tags.remove(&row.id).unwrap_or_default(),
                    archived: row.archived,
                },
            )
        })
        .collect())
}

async fn tags_for(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<HashMap<String, Vec<ThreadTag>>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT thread_id, label, icon FROM thread_tags
         WHERE thread_id IN (SELECT value FROM json_each(?))
         ORDER BY thread_id, position",
    )
    .bind(ids_json)
    .fetch_all(pool)
    .await?;
    let mut map: HashMap<String, Vec<ThreadTag>> = HashMap::new();
    for (thread_id, label, icon) in rows {
        map.entry(thread_id)
            .or_default()
            .push(ThreadTag { label, icon });
    }
    Ok(map)
}

/// すでに使われているタグと、使っているスレッドの数（多い順、同数なら文字列順）。
pub async fn tag_usages(pool: &SqlitePool) -> sqlx::Result<Vec<ThreadTagUsage>> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT label, icon, COUNT(*) AS n FROM thread_tags
         GROUP BY label, icon
         ORDER BY n DESC, label, icon",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(label, icon, n)| ThreadTagUsage {
            tag: ThreadTag { label, icon },
            count: n as u32,
        })
        .collect())
}

/// スレッドを立てた人。
pub async fn thread_creator(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        "SELECT COALESCE(t.created_by, m.author_id) FROM threads t
         JOIN messages m ON m.id = t.id WHERE t.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn set_thread_title(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE threads SET title = ? WHERE id = ?")
        .bind(title)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_thread_archived(pool: &SqlitePool, id: &str, archived: bool) -> sqlx::Result<()> {
    sqlx::query("UPDATE threads SET archived = ? WHERE id = ?")
        .bind(archived)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// スレッドのタグを置き換える。
pub async fn set_thread_tags(
    conn: &mut SqliteConnection,
    id: &str,
    tags: &[ThreadTag],
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM thread_tags WHERE thread_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    for (position, tag) in tags.iter().enumerate() {
        sqlx::query(
            "INSERT INTO thread_tags (thread_id, position, label, icon) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(position as i64)
        .bind(&tag.label)
        .bind(&tag.icon)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub async fn thread_exists(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM threads WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

pub async fn get_thread(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Thread>> {
    Ok(get(pool, id).await?.and_then(into_thread))
}

/// スレッド一覧。最後に動きがあった順（返信がなければ起点の作成時刻）の降順。
///
/// ID（ULID）は作成時刻の順に並ぶので、最新の返信の ID（なければ起点の ID）で並べる。
/// 同じミリ秒の投稿でも順番がぶれない。
pub async fn list_threads(pool: &SqlitePool) -> sqlx::Result<Vec<Thread>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT t.id FROM threads t
         ORDER BY COALESCE((SELECT MAX(r.id) FROM messages r WHERE r.thread_id = t.id), t.id) DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(load(pool, &ids)
        .await?
        .into_iter()
        .filter_map(into_thread)
        .collect())
}

fn into_thread(root: Message) -> Option<Thread> {
    let info = root.thread.clone()?;
    Some(Thread { root, info })
}

/// スレッドに関わっている人（起点の投稿者と、返信した人）。
pub async fn thread_participants(pool: &SqlitePool, thread_id: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT DISTINCT author_id FROM messages WHERE id = ? OR thread_id = ?")
        .bind(thread_id)
        .bind(thread_id)
        .fetch_all(pool)
        .await
}

// ---- 書き込み ----

pub async fn insert(conn: &mut SqliteConnection, row: &MessageRow) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO messages ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&row.id)
    .bind(&row.author_id)
    .bind(&row.thread_id)
    .bind(&row.reply_to)
    .bind(&row.body)
    .bind(row.created_at)
    .bind(row.edited_at)
    .bind(&row.bot_plugin)
    .bind(&row.bot_name)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn insert_thread(
    conn: &mut SqliteConnection,
    id: &str,
    created_by: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO threads (id, created_by, created_at) VALUES (?, ?, ?)")
        .bind(id)
        .bind(created_by)
        .bind(now)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn update_body(pool: &SqlitePool, id: &str, body: &str, now: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?")
        .bind(body)
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// メッセージを消す。スレッドの返信・リアクション・添付ファイルの行は外部キーで一緒に消える。
pub async fn delete(conn: &mut SqliteConnection, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM messages WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn add_reaction(
    pool: &SqlitePool,
    message_id: &str,
    user_id: &str,
    emoji: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(user_id)
    .bind(emoji)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_reaction(
    pool: &SqlitePool,
    message_id: &str,
    user_id: &str,
    emoji: &str,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?")
        .bind(message_id)
        .bind(user_id)
        .bind(emoji)
        .execute(pool)
        .await?;
    Ok(())
}

/// 添付ファイルが付いているか（本文を空にする編集を許すかの判定に使う）。
pub async fn has_attachments(pool: &SqlitePool, id: &str) -> sqlx::Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM files WHERE message_id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

/// `Attachment` の一覧を、メッセージ ID ごとにまとめた型。
pub type AttachmentMap = HashMap<String, Vec<Attachment>>;
