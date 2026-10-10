//! `/api/threads`（スレッド一覧）。

use axum::Json;
use axum::extract::{Path, State};
use disnans_shared::{SetThreadTags, Thread, ThreadTagUsage, UpdateThread};

use crate::auth::CurrentUser;
use crate::chat::{self, Actor};
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

/// すでに使われているタグの一覧（タグを付けるときの選択肢）。
pub async fn tags(State(state): State<SharedState>) -> AppResult<Json<Vec<ThreadTagUsage>>> {
    Ok(Json(messages::tag_usages(&state.pool).await?))
}

/// タイトルとアーカイブを変える（スレッドを立てた人だけ）。
pub async fn update(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateThread>,
) -> AppResult<Json<Thread>> {
    let actor = Actor {
        user: &user,
        conn: None,
    };
    chat::update_thread(&state, &actor, &id, req).await?;
    get(State(state), Path(id)).await
}

/// タグを置き換える（誰でもできる）。
pub async fn set_tags(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(req): Json<SetThreadTags>,
) -> AppResult<Json<Thread>> {
    chat::set_thread_tags(&state, &id, req.tags).await?;
    get(State(state), Path(id)).await
}
