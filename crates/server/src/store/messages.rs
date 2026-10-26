//! messages / reactions テーブル。
//!
//! `Message` は添付ファイル・リアクション・カード・ボットの情報をまとめて組み立てる。

use std::collections::HashMap;

use disnans_shared::{Attachment, BotInfo, Message, Reaction, ReplyPreview};
use sqlx::{SqliteConnection, SqlitePool};

use super::{files, json_ids, sessions};

/// messages テーブルの1行（添付ファイルなどを含まない）。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageRow {
    pub id: String,
    pub author_id: String,
    pub reply_to: Option<String>,
    pub body: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub bot_plugin: Option<String>,
    pub bot_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ReplyRow {
    id: String,
    author_id: String,
    body: String,
    bot_plugin: Option<String>,
    bot_name: Option<String>,
}

/// 返信先の要約に入れる本文の最大文字数。
const PREVIEW_CHARS: usize = 100;

#[derive(sqlx::FromRow)]
struct ReactionRow {
    message_id: String,
    emoji: String,
    user_id: String,
}

/// 列。`thread_id` の列は残してあるが、常に NULL。
const COLUMNS: &str = "id, author_id, reply_to, body, created_at, edited_at, bot_plugin, bot_name";

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

    // 添付は本文のリンクから導く（本文が真実）
    let bodies: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.id.clone(), r.body.clone()))
        .collect();
    let mut attachments = files::attachments_for_bodies(pool, &bodies).await?;
    let mut reactions = reactions_for(pool, &ids_json).await?;
    let mut cards = sessions::cards_for(pool, &ids_json).await?;
    let mut previews = reply_previews_for(pool, &rows).await?;

    let mut by_id: HashMap<String, MessageRow> =
        rows.into_iter().map(|r| (r.id.clone(), r)).collect();
    // 本文のリンク（保存は ID）を、表示では今の名前に戻す
    let names = {
        let bodies: Vec<&str> = by_id.values().map(|r| r.body.as_str()).collect();
        crate::links::to_wire(pool, &bodies).await?
    };
    Ok(ids
        .iter()
        .filter_map(|id| by_id.remove(id))
        .map(|row| Message {
            attachments: attachments.remove(&row.id).unwrap_or_default(),
            reactions: reactions.remove(&row.id).unwrap_or_default(),
            card: cards.remove(&row.id),
            bot: row
                .bot_plugin
                .zip(row.bot_name)
                .map(|(plugin, name)| BotInfo { plugin, name }),
            id: row.id,
            author_id: row.author_id,
            reply_preview: row.reply_to.as_ref().and_then(|to| previews.remove(to)),
            reply_to: row.reply_to,
            body: crate::links::render(&row.body, &names),
            created_at: row.created_at,
            edited_at: row.edited_at,
        })
        .collect())
}

/// 本文の全文検索。空白で区切った語をすべて含むメッセージを、`before` より古いものから新しい順に最大 `limit` 件返す。
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
///
/// 語ごとに「本文に一致する」か「本文が指す添付の、今の名前に一致する」かで見る（AND でつなぐ）。
/// 本文は添付を ID で持つので、名前は `files` を引いて決める（改名したら、次の検索から新しい名前で引ける）。
/// 名前に一致する添付が無い語は、本文だけを見る（余分な走査はしない）。
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

    let mut conds: Vec<String> = Vec::with_capacity(terms.len());
    let mut binds: Vec<String> = Vec::new();
    for term in &terms {
        // trigram の索引は 3 文字以上の語でしか引けない。短い語は LIKE で探す（遅いが、件数は多くない）
        let (body_cond, body_bind) = if term.chars().count() >= 3 {
            // 語をフレーズにする（フレーズ内の二重引用符は二つに直す）
            (
                "m.id IN (SELECT id FROM messages_fts WHERE messages_fts MATCH ?)",
                format!("\"{}\"", term.replace('"', "\"\"")),
            )
        } else {
            (
                "m.body LIKE ? ESCAPE '\\'",
                format!("%{}%", escape_like(term)),
            )
        };
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM files WHERE deleted_at IS NULL AND file_name LIKE ? ESCAPE '\\'",
        )
        .bind(format!("%{}%", escape_like(term)))
        .fetch_all(pool)
        .await?;
        if names.is_empty() {
            conds.push(body_cond.to_owned());
            binds.push(body_bind);
        } else {
            conds.push(format!(
                "({body_cond} OR EXISTS (SELECT 1 FROM json_each(?) AS j
                                        WHERE instr(m.body, '{}' || j.value) > 0))",
                crate::links::ID_PREFIX
            ));
            binds.push(body_bind);
            binds.push(serde_json::to_string(&names).unwrap_or_else(|_| "[]".into()));
        }
    }

    let sql = format!(
        "SELECT m.id FROM messages m
         WHERE {} AND (? IS NULL OR m.id < ?)
         ORDER BY m.id DESC
         LIMIT ?",
        conds.join(" AND ")
    );
    let mut q = sqlx::query_scalar::<_, String>(&sql);
    for bind in binds {
        q = q.bind(bind);
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

/// メッセージを、`before` より古いものから新しい順に最大 `limit` 件取り、古い順に並べて返す。
pub async fn page(
    pool: &SqlitePool,
    before: Option<&str>,
    limit: u32,
) -> sqlx::Result<Vec<Message>> {
    let mut ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM messages
         WHERE (? IS NULL OR id < ?)
         ORDER BY id DESC
         LIMIT ?",
    )
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
        "SELECT m.id, m.author_id, m.body, m.bot_plugin, m.bot_name
         FROM messages m
         WHERE m.id IN (SELECT value FROM json_each(?))",
    )
    .bind(json_ids(&targets))
    .fetch_all(pool)
    .await?;
    let names = {
        let bodies: Vec<&str> = found.iter().map(|r| r.body.as_str()).collect();
        crate::links::to_wire(pool, &bodies).await?
    };
    Ok(found
        .into_iter()
        .map(|r| {
            let text = crate::links::render(&r.body, &names)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
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
                    has_attachments: !crate::links::ids_in(&r.body).is_empty(),
                    bot: r
                        .bot_plugin
                        .zip(r.bot_name)
                        .map(|(plugin, name)| BotInfo { plugin, name }),
                },
            )
        })
        .collect())
}

// ---- 書き込み ----

pub async fn insert(conn: &mut SqliteConnection, row: &MessageRow) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO messages ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&row.id)
    .bind(&row.author_id)
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

pub async fn update_body(
    conn: &mut SqliteConnection,
    id: &str,
    body: &str,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?")
        .bind(body)
        .bind(now)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// メッセージを消す。リアクション・添付ファイルの行は外部キーで一緒に消える。
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

/// `Attachment` の一覧を、メッセージ ID ごとにまとめた型（本文のリンクの順）。
pub type AttachmentMap = HashMap<String, Vec<Attachment>>;
