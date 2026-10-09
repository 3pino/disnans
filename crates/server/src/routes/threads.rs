//! `/api/threads`（スレッド一覧）。

use axum::Json;
use axum::extract::{Path, Query, State};
use disnans_shared::Thread;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::store::messages;

#[derive(Deserialize)]
pub struct ListQuery {
    /// `normal` / `status`。省略するとすべて。
    kind: Option<String>,
}

pub async fn list(
    State(state): State<SharedState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Thread>>> {
    let kind = match q.kind.as_deref().filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(messages::kind_from_str(s).ok_or_else(|| {
            AppError::bad_request("invalid_kind", "kind は normal か status です")
        })?),
    };
    Ok(Json(messages::list_threads(&state.pool, kind).await?))
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
