//! `/api/me`、`/api/users`、`/api/avatars`。

use axum::Json;
use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use disnans_shared::{ServerEvent, UpdateMe, User};
use tokio::io::AsyncWriteExt;

use crate::auth::CurrentUser;
use crate::avatars;
use crate::db;
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

/// アバターの設定（multipart、フィールド名 `file`）。一時ファイルに書いてから変換する。
pub async fn upload_avatar(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> AppResult<Json<User>> {
    while let Some(mut field) = multipart.next_field().await.map_err(bad_multipart)? {
        if field.name() != Some("file") {
            continue;
        }
        let tmp = state
            .config
            .tmp_dir()
            .join(format!("avatar-{}", db::new_id()));
        let written = async {
            let mut out = tokio::fs::File::create(&tmp).await?;
            let mut size = 0;
            while let Some(chunk) = field.chunk().await.map_err(bad_multipart)? {
                size += chunk.len();
                if size > avatars::MAX_UPLOAD_BYTES {
                    return Err(avatars::too_large());
                }
                out.write_all(&chunk).await?;
            }
            out.flush().await?;
            AppResult::Ok(())
        }
        .await;
        if let Err(err) = written {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(err);
        }
        return Ok(Json(avatars::set(&state, &user, tmp).await?));
    }
    Err(AppError::bad_request(
        "missing_file",
        "フィールド `file` がありません",
    ))
}

/// 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す。
pub async fn delete_avatar(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
) -> AppResult<Json<User>> {
    Ok(Json(avatars::clear(&state, &user).await?))
}

/// アバターの画像（WebP）。ID は設定し直すたびに変わるので、長くキャッシュしてよい。
pub async fn avatar(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let not_found = || AppError::not_found("アバターが見つかりません");
    if !avatars::is_valid_file_id(&id) {
        return Err(not_found());
    }
    let data = match tokio::fs::read(avatars::avatar_path(&state.config, &id)).await {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(err) => return Err(err.into()),
    };
    let mut res = data.into_response();
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(res)
}

fn bad_multipart(err: axum::extract::multipart::MultipartError) -> AppError {
    if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return avatars::too_large();
    }
    AppError::bad_request(
        "invalid_upload",
        format!("アップロードを読めませんでした: {err}"),
    )
}
