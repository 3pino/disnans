//! `/api/messages`（メッセージ履歴）。

use axum::Json;
use axum::extract::{Query, State};
use disnans_shared::Message;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::store::messages;

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;
/// 検索語の最大文字数。
const MAX_QUERY_CHARS: usize = 200;

#[derive(Deserialize)]
pub struct ListQuery {
    /// このメッセージ ID より古いものを返す。
    before: Option<String>,
    limit: Option<u32>,
}

pub async fn list(
    State(state): State<SharedState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Message>>> {
    let before = q.before.filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let list = messages::page(&state.pool, before.as_deref(), limit).await?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    /// 検索語。空白で区切ると、すべての語を含むものを探す。大文字・小文字は区別しない。
    q: Option<String>,
    /// このメッセージ ID より古いものを返す（続きを読むとき）。
    before: Option<String>,
    limit: Option<u32>,
}

/// 本文の全文検索。新しい順に返す。
pub async fn search(
    State(state): State<SharedState>,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<Message>>> {
    let query = q.q.unwrap_or_default();
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::bad_request(
            "query_too_long",
            format!("検索語は {MAX_QUERY_CHARS} 文字までです"),
        ));
    }
    let before = q.before.filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let list = messages::search(&state.pool, query, before.as_deref(), limit).await?;
    Ok(Json(list))
}
