//! `/api/sessions`（プラグインのセッション）。

use axum::Json;
use axum::extract::{Path, State};
use disnans_shared::{CreateSession, Session, UpdateSession};

use crate::auth::CurrentUser;
use crate::chat::Actor;
use crate::error::AppResult;
use crate::sessions;
use crate::state::SharedState;

pub async fn create(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Json(req): Json<CreateSession>,
) -> AppResult<Json<Session>> {
    let actor = Actor {
        user: &user,
        conn: None,
    };
    Ok(Json(sessions::create(&state, &actor, req).await?))
}

pub async fn get(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> AppResult<Json<Session>> {
    Ok(Json(sessions::get(&state, &id).await?))
}

pub async fn update(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateSession>,
) -> AppResult<Json<Session>> {
    Ok(Json(sessions::update(&state, &id, req).await?))
}
