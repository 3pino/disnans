//! `/api/plugins`（プラグインの配布・配信・削除と、プラグインからの通知）。

use axum::Json;
use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use disnans_shared::{PluginInfo, PluginNotify};

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::plugins::{self, Package};
use crate::sessions;
use crate::state::SharedState;
use crate::store::plugins as plugin_store;

pub async fn list(State(state): State<SharedState>) -> AppResult<Json<Vec<PluginInfo>>> {
    Ok(Json(plugin_store::list(&state.pool).await?))
}

/// 配布・更新（multipart、フィールド名 `file` を複数）。ファイル名で種類を見分ける。
pub async fn upload(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> AppResult<Json<PluginInfo>> {
    let mut package = Package::default();
    while let Some(mut field) = multipart.next_field().await.map_err(bad_multipart)? {
        if field.name() != Some("file") {
            continue;
        }
        // フォルダーごと選んだときなどはパスが付いてくるので、最後の部分だけ見る
        let file_name = field
            .file_name()
            .and_then(|n| n.rsplit(['/', '\\']).next())
            .unwrap_or_default()
            .to_owned();
        if plugins::content_type(&file_name).is_none() {
            return Err(AppError::bad_request(
                "invalid_file_name",
                format!(
                    "配布できないファイルです（{file_name}）。manifest.json / main.js / styles.css だけです"
                ),
            ));
        }
        let mut data = Vec::new();
        while let Some(chunk) = field.chunk().await.map_err(bad_multipart)? {
            if data.len() + chunk.len() > package.remaining() {
                return Err(plugins::too_large());
            }
            data.extend_from_slice(&chunk);
        }
        package.add(&file_name, data)?;
    }
    Ok(Json(plugins::install(&state, &user, package).await?))
}

pub async fn remove(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    plugins::remove(&state, &user, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 配布されたファイル。クライアントは `?v=<hash>` を付けて取るので、キャッシュは毎回確かめさせる。
pub async fn file(
    State(state): State<SharedState>,
    Path((id, name)): Path<(String, String)>,
) -> AppResult<Response> {
    let not_found = || AppError::not_found("ファイルが見つかりません");
    let content_type = plugins::content_type(&name).ok_or_else(not_found)?;
    if !plugins::is_valid_id(&id) {
        return Err(not_found());
    }
    let info = plugin_store::get(&state.pool, &id)
        .await?
        .ok_or_else(not_found)?;
    if !info.files.contains(&name) {
        return Err(not_found());
    }
    let path = plugins::plugin_dir(&state.config, &id).join(&name);
    let data = match tokio::fs::read(&path).await {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(err) => return Err(err.into()),
    };

    let mut res = data.into_response();
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(res)
}

pub async fn notify(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(req): Json<PluginNotify>,
) -> AppResult<StatusCode> {
    sessions::notify(&state, &id, req).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn bad_multipart(err: axum::extract::multipart::MultipartError) -> AppError {
    if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return plugins::too_large();
    }
    AppError::bad_request(
        "invalid_upload",
        format!("アップロードを読めませんでした: {err}"),
    )
}
