//! `/api/me`、`/api/users`。

use axum::Json;
use axum::extract::State;
use disnans_shared::{ServerEvent, UpdateMe, User};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::store::users;

/// 表示名の最大文字数。
const MAX_DISPLAY_NAME_CHARS: usize = 32;

pub async fn me(CurrentUser(user): CurrentUser) -> Json<User> {
    Json(user)
}

pub async fn update_me(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<UpdateMe>,
) -> AppResult<Json<User>> {
    let name = req.display_name.trim();
    if name.is_empty() || name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(AppError::bad_request(
            "invalid_display_name",
            format!("表示名は 1〜{MAX_DISPLAY_NAME_CHARS} 文字にしてください"),
        ));
    }

    let _guard = state.write_lock().await;
    let user = users::update_display_name(&state.pool, &user.id, name)
        .await?
        .ok_or_else(|| AppError::not_found("ユーザーが見つかりません"))?;
    state
        .hub
        .broadcast(&ServerEvent::UserUpdated { user: user.clone() });
    Ok(Json(user))
}

pub async fn list(State(state): State<SharedState>) -> AppResult<Json<Vec<User>>> {
    Ok(Json(users::list(&state.pool).await?))
}
