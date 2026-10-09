//! plugin_sessions テーブル（プラグインのセッションと、そのカード）。

use std::collections::HashMap;

use disnans_shared::{Card, MessageCard, Session};
use sqlx::{SqliteConnection, SqlitePool};

/// plugin_sessions テーブルの1行。state は JSON 文字列のまま持つ。
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub id: String,
    pub plugin: String,
    pub message_id: String,
    pub created_by: String,
    pub state: String,
    pub version: i64,
    pub card_title: String,
    pub card_text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<SessionRow> for Session {
    fn from(row: SessionRow) -> Self {
        Session {
            // 保存するときに検証しているので、読めないことはない
            state: serde_json::from_str(&row.state).unwrap_or_default(),
            card: Card {
                title: row.card_title,
                text: row.card_text,
            },
            id: row.id,
            plugin: row.plugin,
            message_id: row.message_id,
            created_by: row.created_by,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

const COLUMNS: &str = "id, plugin, message_id, created_by, state, version, card_title, card_text, created_at, updated_at";

pub async fn get(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<SessionRow>> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM plugin_sessions WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// メッセージ ID の JSON 配列（→ `super::json_ids`）に対応するカードを、メッセージ ID ごとに返す。
pub(super) async fn cards_for(
    pool: &SqlitePool,
    ids_json: &str,
) -> sqlx::Result<HashMap<String, MessageCard>> {
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT message_id, id, plugin, card_title, card_text FROM plugin_sessions
         WHERE message_id IN (SELECT value FROM json_each(?))",
    )
    .bind(ids_json)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(message_id, session_id, plugin, title, text)| {
            (
                message_id,
                MessageCard {
                    session_id,
                    plugin,
                    title,
                    text,
                },
            )
        })
        .collect())
}

/// カードのメッセージか（編集を拒否するのに使う）。
pub async fn is_card(pool: &SqlitePool, message_id: &str) -> sqlx::Result<bool> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM plugin_sessions WHERE message_id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some())
}

pub async fn insert(conn: &mut SqliteConnection, row: &SessionRow) -> sqlx::Result<()> {
    sqlx::query(&format!(
        "INSERT INTO plugin_sessions ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&row.id)
    .bind(&row.plugin)
    .bind(&row.message_id)
    .bind(&row.created_by)
    .bind(&row.state)
    .bind(row.version)
    .bind(&row.card_title)
    .bind(&row.card_text)
    .bind(row.created_at)
    .bind(row.updated_at)
    .execute(conn)
    .await?;
    Ok(())
}

/// state・version・カード・更新時刻を書き換える（`row` の値をそのまま書く）。
pub async fn update(pool: &SqlitePool, row: &SessionRow) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE plugin_sessions
         SET state = ?, version = ?, card_title = ?, card_text = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&row.state)
    .bind(row.version)
    .bind(&row.card_title)
    .bind(&row.card_text)
    .bind(row.updated_at)
    .bind(&row.id)
    .execute(pool)
    .await?;
    Ok(())
}
