//! `/api/shared`（共有フォルダ）。WebDAV（`/dav`）と同じ中身と同じ規則で、REST から使う。
//!
//! - `GET /api/shared`: 共有フォルダの中身（一覧）。
//! - `GET /api/shared/{パス}`: フォルダなら一覧、ファイルなら中身（Range 可）。
//! - `PUT /api/shared/{パス}`: 本文をファイルにする（作成・上書き）。親のフォルダが無ければ 409。
//! - `DELETE /api/shared/{パス}`: 削除（フォルダは中身ごと）。
//! - `POST /api/shared`: `{op: "mkdir" | "move" | "copy", ...}`。
//!
//! `attachments/` は読み取り専用（添付の一覧）。名前の検査・一時ファイルからの差し替え・変更の通知は
//! `webdav::fs::SharedFs` が行う。

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use dav_server::fs::{DavFile, FsError, OpenOptions};
use disnans_shared::{SharedEntry, SharedKind, SharedListing, SharedOp};
use futures_util::StreamExt;

use super::files;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::SharedState;
use crate::webdav::fs::{Listed, SharedFs, rel};

/// 区切りの列（空の要素は捨てる）。
fn segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn entry(path: &str, l: &Listed) -> SharedEntry {
    SharedEntry {
        name: l.name.clone(),
        path: path.to_owned(),
        kind: if l.meta.dir {
            SharedKind::Dir
        } else {
            SharedKind::File
        },
        size: l.meta.len,
        modified: l.meta.modified_ms(),
        mime: l.mime.clone(),
        message_id: l.message_id.clone(),
    }
}

/// 親のパスと名前から、項目のパス。
fn child_path(parent: &[String], name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{}/{name}", rel(parent))
    }
}

/// 共有フォルダの失敗を、利用者に見せる形にする。
fn map_err(e: FsError) -> AppError {
    match e {
        FsError::NotFound => AppError::not_found("見つかりません"),
        FsError::Forbidden => {
            AppError::forbidden("この場所は変えられません（名前が使えない場合もあります）")
        }
        FsError::Exists => {
            AppError::new(StatusCode::CONFLICT, "exists", "同じ名前のものがあります")
        }
        FsError::TooLarge => {
            AppError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "大きすぎます")
        }
        FsError::InsufficientStorage => AppError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "insufficient_storage",
            "容量が足りません",
        ),
        _ => AppError::internal("共有フォルダの操作に失敗しました"),
    }
}

async fn listing(fs: &SharedFs, segs: &[String]) -> AppResult<SharedListing> {
    let items = fs.list(segs).await.map_err(map_err)?;
    Ok(SharedListing {
        path: rel(segs),
        entries: items
            .iter()
            .map(|l| entry(&child_path(segs, &l.name), l))
            .collect(),
    })
}

/// 共有フォルダの直下の一覧。
pub async fn list_root(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
) -> AppResult<Json<SharedListing>> {
    let fs = SharedFs::new(&state);
    Ok(Json(listing(&fs, &[]).await?))
}

/// フォルダなら一覧、ファイルなら中身。
pub async fn get(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
    Path(path): Path<String>,
    req: Request,
) -> AppResult<Response> {
    let fs = SharedFs::new(&state);
    let segs = segments(&path);
    let found = fs.stat(&segs).await.map_err(map_err)?;
    if found.meta.dir {
        return Ok(Json(listing(&fs, &segs).await?).into_response());
    }
    let target = fs.read_target(&segs).await.map_err(map_err)?;
    let (mime, disposition) = match &target.mime {
        Some(m) => (m.clone(), files::content_disposition(m, &found.name)),
        None => {
            let m = "application/octet-stream";
            (m.to_owned(), files::content_disposition(m, &found.name))
        }
    };
    files::serve(target.path, &mime, disposition, req).await
}

/// 本文を、そのパスのファイルにする（作成・上書き）。一時ファイルに書いてから差し替える。
pub async fn put(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
    Path(path): Path<String>,
    body: Body,
) -> AppResult<Json<SharedEntry>> {
    let fs = SharedFs::new(&state);
    let segs = segments(&path);
    let options = OpenOptions {
        write: true,
        create: true,
        truncate: true,
        ..Default::default()
    };
    let mut file: Box<dyn DavFile> = fs.write_file(&segs, options).await.map_err(|e| match e {
        // 作成の場合、親のフォルダが無いときだけ NotFound になる
        FsError::NotFound => AppError::new(
            StatusCode::CONFLICT,
            "parent_missing",
            "親のフォルダがありません",
        ),
        other => map_err(other),
    })?;
    let mut chunks = body.into_data_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk =
            chunk.map_err(|_| AppError::bad_request("invalid_body", "本文を読めませんでした"))?;
        file.write_bytes(chunk).await.map_err(map_err)?;
    }
    // ここで名前が差し替わる（途中で切れたら一時ファイルは消える）
    file.flush().await.map_err(map_err)?;
    drop(file);
    let found = fs.stat(&segs).await.map_err(map_err)?;
    Ok(Json(entry(&rel(&segs), &found)))
}

/// 削除。フォルダは中身ごと消す。
pub async fn delete(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
    Path(path): Path<String>,
) -> AppResult<StatusCode> {
    let fs = SharedFs::new(&state);
    fs.remove(&segments(&path), true).await.map_err(map_err)?;
    Ok(StatusCode::NO_CONTENT)
}

/// フォルダの作成・移動・コピー。結果の項目を返す。
pub async fn ops(
    State(state): State<SharedState>,
    CurrentUser(_user): CurrentUser,
    Json(op): Json<SharedOp>,
) -> AppResult<Json<SharedEntry>> {
    let fs = SharedFs::new(&state);
    let to = match op {
        SharedOp::Mkdir { path } => {
            let segs = segments(&path);
            fs.make_dir(&segs).await.map_err(map_err)?;
            segs
        }
        SharedOp::Move { from, to } => {
            let to = segments(&to);
            fs.rename(&segments(&from), &to).await.map_err(map_err)?;
            to
        }
        SharedOp::Copy { from, to } => {
            let to = segments(&to);
            fs.copy(&segments(&from), &to).await.map_err(map_err)?;
            to
        }
    };
    let found = fs.stat(&to).await.map_err(map_err)?;
    Ok(Json(entry(&rel(&to), &found)))
}
