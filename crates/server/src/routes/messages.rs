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
    /// 省略するとメインチャット、指定するとそのスレッドの返信（起点は含まない）。
    thread_id: Option<String>,
    /// このメッセージ ID より古いものを返す。
    before: Option<String>,
    limit: Option<u32>,
}

pub async fn list(
    State(state): State<SharedState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Message>>> {
    // `?thread_id=` のような空の値は、省略と同じに扱う
    let thread_id = q.thread_id.filter(|s| !s.is_empty());
    let before = q.before.filter(|s| !s.is_empty());
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    if let Some(thread_id) = &thread_id
        && !messages::thread_exists(&state.pool, thread_id).await?
    {
        return Err(AppError::not_found("スレッドが見つかりません"));
    }

    let list = messages::page(&state.pool, thread_id.as_deref(), before.as_deref(), limit).await?;
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

/// 本文の全文検索。メインチャットとスレッドの返信の両方を対象にし、新しい順に返す。
/// どこのメッセージかは `thread_id` でわかる（メインチャットなら `null`）。
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
