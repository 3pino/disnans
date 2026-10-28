//! `/api/shared-trash`（共有フォルダのゴミ箱）。
//!
//! - `GET /api/shared-trash`: ゴミ箱の一覧（完了したものだけ）。
//! - `POST /api/shared-trash`: `{op: "trash", path}` でゴミ箱へ入れる（添付は `attachments/<名前>`）→ [`SharedTrashEntry`]。
//!   `{op: "restore", id}` で元へ戻す → 戻した項目の [`SharedEntry`]。
//! - `DELETE /api/shared-trash/{id}`: 完全に消す（204）。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use disnans_shared::{SharedTrashListing, SharedTrashOp};

use super::shared::entry;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::trash;
use crate::webdav::fs::{SharedFs, rel};
use crate::webdav::tree::ATTACHMENTS_DIR;

pub async fn list(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
) -> AppResult<Json<SharedTrashListing>> {
    Ok(Json(SharedTrashListing {
        entries: trash::list(&state).await?,
    }))
}

fn segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

pub async fn ops(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Json(op): Json<SharedTrashOp>,
) -> AppResult<Response> {
    match op {
        SharedTrashOp::Trash { path } => {
            let segs = segments(&path);
            let entry = match segs.as_slice() {
                [root, name] if root == ATTACHMENTS_DIR => {
                    let item = crate::store::files::attachment_items(&state.pool)
                        .await?
                        .into_iter()
                        .find(|i| i.name.to_lowercase() == name.to_lowercase())
                        .ok_or_else(|| AppError::not_found("添付が見つかりません"))?;
                    trash::trash_attachment(&state, &item.file_id).await?
                }
                _ => trash::trash_shared(&state, &user.id, &segs).await?,
            };
            Ok(Json(entry).into_response())
        }
        SharedTrashOp::Restore { id } => {
            let path = trash::restore(&state, &id).await?;
            let segs = segments(&path);
            let fs = SharedFs::new(&state, &user.id);
            let found = fs
                .stat(&segs)
                .await
                .map_err(|_| AppError::not_found("見つかりません"))?;
            Ok(Json(entry(&rel(&segs), &found)).into_response())
        }
    }
}

pub async fn purge(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    trash::purge(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
