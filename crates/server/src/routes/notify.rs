//! `/api/notify/sample`。

use axum::extract::State;
use axum::http::StatusCode;

use crate::auth::CurrentUser;
use crate::notify::Notification;
use crate::state::SharedState;

/// 自分にサンプルの通知を送る（通知が届くかの確認用）。
pub async fn sample(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
) -> StatusCode {
    state.notifier.notify(&user.id, &Notification::sample());
    StatusCode::NO_CONTENT
}
