//! `/api/files`（アップロードと配信）。

use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, Request, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use disnans_shared::Attachment;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::files::{self, Stored};
use crate::state::SharedState;
use crate::store::files::{self as file_store, FileRow};

/// アップロード（multipart、フィールド名 `file`）。ディスクにストリーミングで書いてから変換する。
pub async fn upload(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    mut multipart: Multipart,
) -> AppResult<Json<Attachment>> {
    while let Some(mut field) = multipart.next_field().await.map_err(bad_multipart)? {
        if field.name() != Some("file") {
            continue;
        }
        let file_name = files::sanitize_file_name(field.file_name());
        let mime = field
            .content_type()
            .filter(|m| m.parse::<mime::Mime>().is_ok())
            .unwrap_or("application/octet-stream")
            .to_owned();

        let ulid = db::new_ulid();
        let id = ulid.to_string();
        let tmp = state.config.tmp_dir().join(&id);

        // 一時ファイルに書く。失敗したら消す
        let written = async {
            let mut out = tokio::fs::File::create(&tmp).await?;
            while let Some(chunk) = field.chunk().await.map_err(bad_multipart)? {
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

        let dest = files::file_path(&state.config, &id);
        let thumb = files::thumb_path(&state.config, &id);
        let tmp_for_task = tmp.clone();
        let max_edge = state.config.image_max_edge;
        let stored: Stored = tokio::task::spawn_blocking(move || {
            files::store_upload(&tmp_for_task, &dest, &thumb, file_name, mime, max_edge)
        })
        .await
        .map_err(AppError::internal)?
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;

        let row = FileRow {
            id,
            uploader_id: user.id,
            message_id: None,
            file_name: stored.file_name,
            mime: stored.mime,
            size: stored.size as i64,
            width: stored.width.map(i64::from),
            height: stored.height.map(i64::from),
            has_thumb: stored.has_thumb,
            created_at: ulid.timestamp_ms() as i64,
        };
        if let Err(err) = file_store::insert(&state.pool, &row).await {
            files::remove_stored(&state.config, std::slice::from_ref(&row.id)).await;
            return Err(err.into());
        }
        tracing::info!(id = %row.id, mime = %row.mime, size = row.size, "ファイルを保存しました");
        return Ok(Json(row.into()));
    }
    Err(AppError::bad_request(
        "missing_file",
        "フィールド `file` がありません",
    ))
}

/// ファイル本体。Range リクエストにも対応する（動画のシークなど）。
pub async fn get(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    req: Request,
) -> AppResult<Response> {
    let row = find(&state, &id).await?;
    let path = files::file_path(&state.config, &row.id);
    let disposition = content_disposition(&row.mime, &row.file_name);
    serve(path, &row.mime, disposition, req).await
}

/// サムネイル（WebP）。
pub async fn thumb(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    req: Request,
) -> AppResult<Response> {
    let row = find(&state, &id).await?;
    if !row.has_thumb {
        return Err(AppError::not_found("サムネイルがありません"));
    }
    let path = files::thumb_path(&state.config, &row.id);
    serve(path, "image/webp", HeaderValue::from_static("inline"), req).await
}

async fn find(state: &SharedState, id: &str) -> AppResult<FileRow> {
    file_store::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("ファイルが見つかりません"))
}

async fn serve(
    path: std::path::PathBuf,
    mime: &str,
    disposition: HeaderValue,
    req: Request,
) -> AppResult<Response> {
    if !tokio::fs::try_exists(&path).await? {
        return Err(AppError::not_found("ファイルが見つかりません"));
    }
    let mime: mime::Mime = mime.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);
    let Ok(res) = ServeFile::new_with_mime(path, &mime).oneshot(req).await;
    let mut res = res.map(Body::new);

    let headers = res.headers_mut();
    headers.insert(header::CONTENT_DISPOSITION, disposition);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // ファイルの中身は変わらない（ID ごとに作り直す）ので、長くキャッシュしてよい
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    Ok(res)
}

/// 画像・動画・音声はその場で表示し、それ以外はダウンロードさせる。
///
/// SVG や HTML はスクリプトを含められるので、同じオリジンで開かれないよう必ずダウンロードにする。
fn content_disposition(mime: &str, file_name: &str) -> HeaderValue {
    let inline = (mime.starts_with("image/") && mime != "image/svg+xml")
        || mime.starts_with("video/")
        || mime.starts_with("audio/");
    let kind = if inline { "inline" } else { "attachment" };

    // ASCII 以外のファイル名は RFC 5987 の形式（filename*）で送る
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if (c.is_ascii_graphic() && c != '"' && c != '\\') || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded = utf8_percent_encode(file_name, NON_ALPHANUMERIC);
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

fn bad_multipart(err: axum::extract::multipart::MultipartError) -> AppError {
    AppError::bad_request(
        "invalid_upload",
        format!("アップロードを読めませんでした: {err}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_content_disposition() {
        assert_eq!(
            content_disposition("image/webp", "写真.webp"),
            "inline; filename=\"__.webp\"; filename*=UTF-8''%E5%86%99%E7%9C%9F%2Ewebp"
        );
        assert_eq!(
            content_disposition("image/svg+xml", "a.svg"),
            "attachment; filename=\"a.svg\"; filename*=UTF-8''a%2Esvg"
        );
        assert!(
            content_disposition("text/html", "x.html")
                .to_str()
                .unwrap()
                .starts_with("attachment")
        );
    }
}
