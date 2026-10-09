//! `/api/me/read`（既読の位置と未読数）。

use axum::Json;
use axum::extract::State;
use disnans_shared::{MarkRead, ReadMarker, ServerEvent};
use ulid::Ulid;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::store::{messages, reads};

/// メインチャットとすべてのスレッドの既読の位置と未読数（メインチャットが先頭）。
pub async fn list(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
) -> AppResult<Json<Vec<ReadMarker>>> {
    Ok(Json(reads::list(&state.pool, &user).await?))
}

/// 既読の位置を進める（戻さない）。進んだら、自分のすべての接続に `read.updated` を送る。
pub async fn mark(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<MarkRead>,
) -> AppResult<Json<ReadMarker>> {
    // ULID の形でなければ受け付けない（大小の比較が崩れるため）
    let message_id = Ulid::from_string(&req.message_id)
        .map_err(|_| AppError::bad_request("invalid_message_id", "メッセージ ID が不正です"))?
        .to_string();
    let thread_id = req.thread_id.as_deref().filter(|s| !s.is_empty());

    // 未読数をメッセージの配信と同じ順番で数えるため、書き込みのロックを持ったまま数えて配信する
    let _guard = state.write_lock().await;
    if let Some(thread_id) = thread_id
        && !messages::thread_exists(&state.pool, thread_id).await?
    {
        return Err(AppError::not_found("スレッドが見つかりません"));
    }
    let changed = reads::advance(&state.pool, &user, thread_id, &message_id, db::now_ms()).await?;
    let marker = reads::get(&state.pool, &user, thread_id)
        .await?
        .ok_or_else(|| AppError::not_found("スレッドが見つかりません"))?;
    if changed {
        state.hub.send_to_user(
            &user.id,
            &ServerEvent::ReadUpdated {
                marker: marker.clone(),
            },
        );
    }
    Ok(Json(marker))
}
