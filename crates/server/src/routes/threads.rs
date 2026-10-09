//! `/api/threads`（スレッド一覧）。

use axum::Json;
use axum::extract::{Path, State};
use disnans_shared::Thread;

use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::store::messages;

/// クエリ文字列は受け取らない（古いクライアントの `?kind=` などは無視する）。
pub async fn list(State(state): State<SharedState>) -> AppResult<Json<Vec<Thread>>> {
    Ok(Json(messages::list_threads(&state.pool).await?))
}

pub async fn get(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> AppResult<Json<Thread>> {
    messages::get_thread(&state.pool, &id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::not_found("スレッドが見つかりません"))
}
