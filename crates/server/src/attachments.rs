//! 添付（`attachments/` の中身と、投稿されたアップロード）の操作。
//!
//! DB の行と、ファイル（`data/files/<ID>` と `<ID>.thumb`）をそろえて変える。
//! 書き込みは `AppState::write_lock` の中で行う（別名の一意性を守るため）。
//! 中身の差し替えは、必ず一時ファイルに書いてから rename する（バックアップのハードリンクを守るため）。
//! 変更は `files.changed`（`attachments/<別名>`）で知らせる。

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use disnans_shared::ServerEvent;
use sqlx::SqlitePool;

use crate::attachment_names::{key, numbered};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::files::{self, Stored};
use crate::state::SharedState;
use crate::store::files::{self as store, Content, FileRow};

/// 別名の決め方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Naming {
    /// 名前をそのまま使う（同じ名前があれば `exists`）。
    Exact,
    /// アップロードの名前（画像なら WebP の名前）から、空いている名前を選ぶ（`name (2).ext`…）。
    Unique,
}

/// 同じ名前の添付があるときの決まり（PUT・コピー）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    /// 同じ名前があれば `exists`。
    CreateOnly,
    /// 同じ名前があれば、その添付（同じ ID）の中身を差し替える。
    Overwrite,
}

/// `attachments/` の中の、その別名のパス（変更の通知に使う）。
pub fn path_of(name: &str) -> String {
    format!("attachments/{name}")
}

fn exists() -> AppError {
    AppError::new(StatusCode::CONFLICT, "exists", "同じ名前の添付があります")
}

fn not_found() -> AppError {
    AppError::not_found("添付が見つかりません")
}

/// 変換して保存する。失敗したら、作りかけのファイルを消す。`tmp` はなくなる。
async fn process(
    state: &SharedState,
    tmp: PathBuf,
    dest: &Path,
    thumb: &Path,
    name: String,
    mime: String,
) -> AppResult<Stored> {
    let max_edge = state.config.image_max_edge;
    let (tmp_for, dest_for, thumb_for) = (tmp.clone(), dest.to_owned(), thumb.to_owned());
    let result = tokio::task::spawn_blocking(move || {
        files::store_upload(&tmp_for, &dest_for, &thumb_for, name, mime, max_edge)
    })
    .await
    .map_err(AppError::internal)
    .and_then(|r| r.map_err(AppError::internal));
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let _ = tokio::fs::remove_file(dest).await;
        let _ = tokio::fs::remove_file(thumb).await;
    }
    result
}

/// 空いている別名を、DB で確かめながら選ぶ。
async fn free_name(pool: &SqlitePool, base: &str) -> sqlx::Result<String> {
    let mut candidate = base.to_owned();
    let mut n = 2usize;
    while store::live_by_key(pool, &key(&candidate)).await?.is_some() {
        candidate = numbered(base, n);
        n += 1;
    }
    Ok(candidate)
}

fn announce(state: &SharedState, name: &str) {
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: path_of(name),
    });
}

/// 新しい添付を作る（アップロード、または `attachments/` の中への作成）。`library` は投稿されていない直接の添付。
pub async fn create(
    state: &SharedState,
    uploader_id: &str,
    tmp: PathBuf,
    name: &str,
    mime: String,
    naming: Naming,
    library: bool,
) -> AppResult<FileRow> {
    let ulid = db::new_ulid();
    let id = ulid.to_string();
    let dest = files::file_path(&state.config, &id);
    let thumb = files::thumb_path(&state.config, &id);
    let stored = process(state, tmp, &dest, &thumb, name.to_owned(), mime).await?;

    let row = {
        let _guard = state.write_lock().await;
        let file_name = match naming {
            Naming::Exact => {
                if store::live_by_key(&state.pool, &key(name)).await?.is_some() {
                    drop(_guard);
                    files::remove_stored(&state.config, std::slice::from_ref(&id)).await;
                    return Err(exists());
                }
                name.to_owned()
            }
            Naming::Unique => {
                free_name(
                    &state.pool,
                    &crate::attachment_names::clean(&stored.file_name),
                )
                .await?
            }
        };
        let row = FileRow {
            id: id.clone(),
            uploader_id: uploader_id.to_owned(),
            message_id: None,
            file_name,
            mime: stored.mime,
            size: stored.size as i64,
            width: stored.width.map(i64::from),
            height: stored.height.map(i64::from),
            has_thumb: stored.has_thumb,
            library,
            deleted_at: None,
            first_posted_at: None,
            created_at: ulid.timestamp_ms() as i64,
        };
        if let Err(err) = store::insert(&state.pool, &row).await {
            files::remove_stored(&state.config, std::slice::from_ref(&id)).await;
            return Err(err.into());
        }
        row
    };
    if library {
        announce(state, &row.file_name);
    }
    Ok(row)
}

/// 同じ ID の添付の中身を差し替える（別名を `new_name` にすることもある）。
/// 差し替えは一時ファイルに書いてから rename する。
pub async fn replace(
    state: &SharedState,
    id: &str,
    tmp: PathBuf,
    new_name: Option<&str>,
    mime: String,
) -> AppResult<FileRow> {
    let current = store::get(&state.pool, id)
        .await?
        .filter(|r| r.deleted_at.is_none())
        .ok_or_else(not_found)?;
    let name = new_name.unwrap_or(&current.file_name).to_owned();

    let work = db::new_ulid().to_string();
    let blob_tmp = state.config.tmp_dir().join(format!("{work}.blob"));
    let thumb_tmp = state.config.tmp_dir().join(format!("{work}.thumb"));
    let stored = process(state, tmp, &blob_tmp, &thumb_tmp, name.clone(), mime).await?;

    let row = {
        let _guard = state.write_lock().await;
        let clash = store::live_by_key(&state.pool, &key(&name)).await?;
        if clash.is_some_and(|other| other.id != id) {
            drop(_guard);
            let _ = tokio::fs::remove_file(&blob_tmp).await;
            let _ = tokio::fs::remove_file(&thumb_tmp).await;
            return Err(exists());
        }
        tokio::fs::rename(&blob_tmp, files::file_path(&state.config, id)).await?;
        let thumb = files::thumb_path(&state.config, id);
        if stored.has_thumb {
            tokio::fs::rename(&thumb_tmp, &thumb).await?;
        } else {
            let _ = tokio::fs::remove_file(&thumb_tmp).await;
            let _ = tokio::fs::remove_file(&thumb).await;
        }
        store::set_content(
            &mut *state.pool.acquire().await?,
            id,
            &Content {
                file_name: &name,
                mime: &stored.mime,
                size: stored.size as i64,
                width: stored.width.map(i64::from),
                height: stored.height.map(i64::from),
                has_thumb: stored.has_thumb,
            },
        )
        .await?;
        FileRow {
            file_name: name,
            mime: stored.mime,
            size: stored.size as i64,
            width: stored.width.map(i64::from),
            height: stored.height.map(i64::from),
            has_thumb: stored.has_thumb,
            ..current
        }
    };
    announce(state, &row.file_name);
    Ok(row)
}

/// `attachments/` の中に一つのファイルを置く（PUT・コピー）。同じ名前があれば `put` の決まりどおり。
pub async fn put(
    state: &SharedState,
    uploader_id: &str,
    tmp: PathBuf,
    name: &str,
    mime: String,
    mode: Put,
) -> AppResult<FileRow> {
    if let Some(existing) = store::live_by_key(&state.pool, &key(name)).await? {
        return match mode {
            Put::CreateOnly => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(exists())
            }
            Put::Overwrite => replace(state, &existing.id, tmp, Some(name), mime).await,
        };
    }
    create(state, uploader_id, tmp, name, mime, Naming::Exact, true).await
}

/// 別の場所にあるファイルを、`attachments/` の中へコピーする（中身は複製し、変換も通す）。
pub async fn copy_in(
    state: &SharedState,
    uploader_id: &str,
    src: &Path,
    name: &str,
    mime: String,
    mode: Put,
) -> AppResult<FileRow> {
    let tmp = state
        .config
        .tmp_dir()
        .join(format!("{}.copy", db::new_ulid()));
    if let Err(err) = tokio::fs::copy(src, &tmp).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(match err.kind() {
            std::io::ErrorKind::NotFound => not_found(),
            _ => AppError::internal(err),
        });
    }
    put(state, uploader_id, tmp, name, mime, mode).await
}

/// 別名を変える（`attachments/` の中だけ）。宛先が同じ別名なら `overwrite` のときだけ、その添付を消して入れる。
pub async fn rename(
    state: &SharedState,
    id: &str,
    new_name: &str,
    overwrite: bool,
) -> AppResult<()> {
    let mut removed: Option<FileRow> = None;
    {
        let _guard = state.write_lock().await;
        let current = store::get(&state.pool, id)
            .await?
            .filter(|r| r.deleted_at.is_none())
            .ok_or_else(not_found)?;
        let mut tx = state.pool.begin().await?;
        if let Some(other) = store::live_by_key(&state.pool, &key(new_name)).await?
            && other.id != current.id
        {
            if !overwrite {
                return Err(exists());
            }
            remove_row(&mut tx, &other).await?;
            removed = Some(other);
        }
        store::set_name(&mut tx, id, new_name).await?;
        tx.commit().await?;
        announce(state, &current.file_name);
    }
    if let Some(other) = removed {
        files::remove_stored(&state.config, std::slice::from_ref(&other.id)).await;
        announce(state, &other.file_name);
    }
    announce(state, new_name);
    Ok(())
}

/// `attachments/` から消す。投稿されていた添付は、行を残して「削除された」にする（本体は消す）。
/// 投稿されていない直接の添付は、行ごと消す。
pub async fn remove(state: &SharedState, id: &str) -> AppResult<()> {
    let name = {
        let _guard = state.write_lock().await;
        let current = store::get(&state.pool, id)
            .await?
            .filter(|r| r.deleted_at.is_none())
            .ok_or_else(not_found)?;
        let mut tx = state.pool.begin().await?;
        remove_row(&mut tx, &current).await?;
        tx.commit().await?;
        current.file_name
    };
    files::remove_stored(&state.config, &[id.to_owned()]).await;
    announce(state, &name);
    Ok(())
}

/// 本人が投稿前に取り消す（送信の取り消し・添付の外し）。本人のアップロードで、まだどの本文にも投稿されていないものだけ。
/// 行と本体を消す（投稿されていないので「削除された」の印は付けない）。
pub async fn discard(state: &SharedState, user_id: &str, id: &str) -> AppResult<()> {
    let name = {
        let _guard = state.write_lock().await;
        let current = store::get(&state.pool, id)
            .await?
            .filter(|r| r.deleted_at.is_none())
            .ok_or_else(not_found)?;
        if current.uploader_id != user_id {
            return Err(AppError::forbidden("ほかの人のファイルは消せません"));
        }
        if current.message_id.is_some() || current.library {
            return Err(AppError::forbidden(
                "投稿済み・ライブラリの添付は、ここからは消せません",
            ));
        }
        let mut tx = state.pool.begin().await?;
        if store::referencing_message(&mut tx, id, None).await?.is_some() {
            return Err(AppError::forbidden("本文から参照されているため消せません"));
        }
        store::purge(&mut tx, id).await?;
        tx.commit().await?;
        current.file_name
    };
    files::remove_stored(&state.config, &[id.to_owned()]).await;
    announce(state, &name);
    Ok(())
}

/// 行を消す（どこかの本文が参照していれば印を付けるだけ）。本体は呼び出し側で消す。
async fn remove_row(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, row: &FileRow) -> AppResult<()> {
    if store::referencing_message(tx, &row.id, None).await?.is_some() {
        store::mark_deleted(tx, &row.id, db::now_ms()).await?;
    } else {
        store::purge(tx, &row.id).await?;
    }
    Ok(())
}
