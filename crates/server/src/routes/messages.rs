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
