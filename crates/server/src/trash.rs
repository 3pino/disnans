//! 共有フォルダのゴミ箱（`data/trash/<ID>/`）。共有フォルダの項目と添付を、消さずに入れておける。
//!
//! 置き場所は共有フォルダの外なので、一覧・WebDAV・共有の HTTP からは読めない。
//! 1 件は `shared_trash` の行と、その中の実体:
//! - 共有フォルダの項目（ファイル・フォルダ）: `item`（移した実体そのもの）
//! - 添付: `blob`（本体）と `thumb`（サムネイル）。行の `payload` に files 行の全部を入れる。files 行は
//!   `deleted_at` で隠す（投稿の本文のリンクは「削除された」になる。復元で戻る）。
//!
//! 変更の順序（途中で止まっても実体を失わないため）:
//! 1. 行を `pending` で先に入れる（ID と元の場所・種類）
//! 2. 実体を移す（上書きしない名前の変更。消さない）。添付は blob の後に thumb
//! 3. 行を `ready` にする（添付は files 行を隠すのと同じ tx）
//!
//! 復元・完全削除も、途中の状態（`restoring` / `purging`）を行に残す。起動時の [`recover`] が、行と実体の
//! 有無から、戻すか進めるかを決める。どちらとも決められないものは `broken` にして、消さずに
//! 操作を拒否する。
//!
//! 移動はすべて [`crate::noreplace::rename_no_replace`] で行う（同名があれば失敗し、どちらも残る）。
//! 復元の同名の確認も、先に存在を見ずに、移動の失敗（`AlreadyExists`）で決める。
//!
//! 完全削除（purge）は、変更の通知（`files.changed`）を配信する（元の項目の path）。
//! 添付の復元で元の投稿が消えていたら、投稿は作り直さず、ライブラリの添付として同じ ID で戻す。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use dav_server::fs::{FsError, FsResult};

use axum::http::StatusCode;
use disnans_shared::{ServerEvent, SharedKind, SharedTrashEntry, SharedTrashNode};
use sqlx::SqlitePool;

use crate::attachment_names::key;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::noreplace::rename_no_replace;
use crate::state::SharedState;
use crate::store::files::{self as store, FileRow};
use crate::webdav::fs::{SharedFs, rel};
use crate::webdav::tree::ATTACHMENTS_DIR;
use crate::webdav::usage::{Usage, usage};

const PENDING: &str = "pending";
const READY: &str = "ready";
const RESTORING: &str = "restoring";
const PURGING: &str = "purging";
const BROKEN: &str = "broken";

const KIND_DIR: &str = "dir";
const KIND_FILE: &str = "file";
const KIND_ATTACHMENT: &str = "attachment";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub original_path: String,
    pub size: i64,
    pub deleted_at: i64,
    pub file_id: Option<String>,
    pub payload: Option<String>,
}

fn io_app(e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::NotFound => AppError::not_found("見つかりません"),
        std::io::ErrorKind::AlreadyExists => {
            AppError::new(StatusCode::CONFLICT, "exists", "同じ名前のものがあります")
        }
        std::io::ErrorKind::PermissionDenied => AppError::forbidden("この場所は変えられません"),
        std::io::ErrorKind::Unsupported => AppError::new(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported",
            "この環境では上書きしない移動ができないので、動かしません",
        ),
        _ => AppError::internal(e),
    }
}

fn conflict(code: &'static str, message: &str) -> AppError {
    AppError::new(StatusCode::CONFLICT, code, message)
}

fn exists_at(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// 区切りの列（`a/b/c`）。空の要素は捨てる。
fn segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// ゴミ箱の 1 件のフォルダ（`trash/<ID>/`）。
fn entry_dir(state: &SharedState, id: &str) -> PathBuf {
    state.config.trash_dir().join(id)
}

/// 変更の通知の path: 操作した項目そのものの path（共有の項目も添付も元の path）。
/// 購読側は項目の親と子孫を読み直す（既存の `SharedFs::notify` と同じ）。
fn notify_path(row: &Row) -> String {
    row.original_path.clone()
}

/// 変更の通知: 元の項目の path と、仮想の `.trash`（そのなかの項目は子孫として無効になる）。
fn announce(state: &SharedState, path: String) {
    state.hub.broadcast(&ServerEvent::FilesChanged { path });
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: NAMESPACE.to_owned(),
    });
}

fn kind_of(row: &Row) -> SharedKind {
    if row.kind == KIND_DIR {
        SharedKind::Dir
    } else {
        SharedKind::File
    }
}

/// ゴミ箱の一覧の 1 件。`active` は、要求で一度だけ調べた結果（行ごとに調べ直さない）。
fn entry_of(active: bool, row: &Row) -> SharedTrashEntry {
    SharedTrashEntry {
        id: row.id.clone(),
        original_path: row.original_path.clone(),
        kind: kind_of(row),
        size: row.size.max(0) as u64,
        deleted_at: row.deleted_at,
        trash_path: trash_path_for(active, row),
    }
}

// ---- DB の小さな操作 ----

async fn get_row(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Row>> {
    sqlx::query_as(
        "SELECT id, kind, state, original_path, size, deleted_at, file_id, payload FROM shared_trash WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

async fn set_state(pool: &SqlitePool, id: &str, state: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE shared_trash SET state = ? WHERE id = ?")
        .bind(state)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn delete_row(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM shared_trash WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn insert_pending(pool: &SqlitePool, row: &Row) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at, file_id, payload)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.kind)
    .bind(&row.original_path)
    .bind(row.size)
    .bind(row.deleted_at)
    .bind(&row.file_id)
    .bind(&row.payload)
    .execute(pool)
    .await?;
    Ok(())
}

/// 途中で止まった行があるか（pending・restoring・purging。broken は含めない。ロックは取らない）。
async fn has_unfinished(pool: &SqlitePool) -> sqlx::Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM shared_trash WHERE state IN ('pending', 'restoring', 'purging')",
    )
    .fetch_one(pool)
    .await?;
    Ok(n > 0)
}

/// 途中の行があれば、ロックの中で一度だけ回復する（途中の操作とは競わない。DB が戻っていれば再起動なしで ready になる）。
async fn settle(state: &SharedState) -> AppResult<()> {
    if has_unfinished(&state.pool).await? {
        let _guard = state.write_lock().await;
        // ロックを待つ間に、別の操作が終わっているかもしれないので、改めて確かめる
        if has_unfinished(&state.pool).await? {
            reconcile(state).await?;
        }
    }
    Ok(())
}

/// 一覧（完了したものだけ）。途中のものと broken は出さない。
pub async fn list(state: &SharedState) -> AppResult<Vec<SharedTrashEntry>> {
    // 要求の中で一度だけ調べる（行ごとに、共有フォルダの一覧を読み直さない）
    let active = namespace_active(state).await;
    Ok(ready_rows(state)
        .await?
        .iter()
        .map(|r| entry_of(active, r))
        .collect())
}

/// 完了した行（ready）だけ。読む前に途中の行を回復する。
pub async fn ready_rows(state: &SharedState) -> AppResult<Vec<Row>> {
    settle(state).await?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, state, original_path, size, deleted_at, file_id, payload
         FROM shared_trash WHERE state = 'ready' ORDER BY deleted_at DESC, id DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows)
}

/// 操作の対象の行。無ければ 404、途中・壊れたものは 409（消さずに止める）。
async fn ready_row(state: &SharedState, id: &str) -> AppResult<Row> {
    let row = get_row(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("ゴミ箱に見つかりません"))?;
    match row.state.as_str() {
        READY => Ok(row),
        BROKEN => Err(conflict(
            "trash_broken",
            "中身が合わないため、ここからは操作できません（ログを確認してください）",
        )),
        _ => Err(conflict(
            "trash_busy",
            "処理の途中です。しばらくして再度試してください",
        )),
    }
}

// ---- 共有フォルダの項目をゴミ箱へ ----

/// 共有フォルダの項目（フォルダ・ファイル）をゴミ箱へ入れる。`segs` は共有フォルダの中の区切りの列。
/// 添付（`attachments/…`）は [`trash_attachment`] を使う（ここでは扱わない）。
pub async fn trash_shared(
    state: &SharedState,
    user_id: &str,
    segs: &[String],
) -> AppResult<SharedTrashEntry> {
    if segs.is_empty() || segs[0] == ATTACHMENTS_DIR {
        return Err(AppError::forbidden("この場所はゴミ箱へ入れられません"));
    }
    // 仮想の `.trash` は、ゴミ箱そのもの（入れられない）
    if segs[0].eq_ignore_ascii_case(NAMESPACE) && namespace_active(state).await {
        return Err(AppError::forbidden("この場所はゴミ箱へ入れられません"));
    }
    let fs = SharedFs::new(state, user_id);
    let _guard = state.write_lock().await;
    let src = fs
        .real_path(segs, true)
        .map_err(|_| AppError::forbidden("この名前はゴミ箱へ入れられません"))?;
    let meta = std::fs::symlink_metadata(&src).map_err(io_app)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::forbidden("リンクはゴミ箱へ入れられません"));
    }
    let kind = if meta.is_dir() { KIND_DIR } else { KIND_FILE };
    let usage = {
        let src = src.clone();
        tokio::task::spawn_blocking(move || crate::webdav::usage::usage(&src, &[]))
            .await
            .map_err(AppError::internal)?
            .map_err(io_app)?
    };
    let row = Row {
        id: db::new_id(),
        kind: kind.to_owned(),
        state: PENDING.to_owned(),
        original_path: rel(segs),
        size: usage.size as i64,
        deleted_at: db::now_ms(),
        file_id: None,
        payload: None,
    };
    insert_pending(&state.pool, &row).await?;
    let dir = entry_dir(state, &row.id);
    let item = dir.join("item");
    let moved = std::fs::create_dir(&dir).and_then(|_| rename_no_replace(&src, &item));
    if let Err(e) = moved {
        // 動いていないので、元のまま。行と作りかけのフォルダを消す
        let _ = std::fs::remove_dir(&dir);
        delete_row(&state.pool, &row.id).await?;
        return Err(io_app(e));
    }
    set_state(&state.pool, &row.id, READY).await?;
    announce(state, notify_path(&row));
    let active = namespace_active(state).await;
    Ok(entry_of(
        active,
        &Row {
            state: READY.to_owned(),
            ..row
        },
    ))
}

// ---- 添付をゴミ箱へ ----

/// 添付をゴミ箱へ入れる。`attachments/<名前>` の添付（投稿済み・ライブラリのもの）。
/// blob と thumb を動かし、files 行は `deleted_at` で隠す（remove_row は呼ばない）。
pub async fn trash_attachment(state: &SharedState, file_id: &str) -> AppResult<SharedTrashEntry> {
    let _guard = state.write_lock().await;
    let row = store::get(&state.pool, file_id)
        .await?
        .filter(|r| r.deleted_at.is_none() && (r.message_id.is_some() || r.library))
        .ok_or_else(|| AppError::not_found("添付が見つかりません"))?;
    let payload = serde_json::to_string(&row).map_err(AppError::internal)?;
    let trash_row = Row {
        id: db::new_id(),
        kind: KIND_ATTACHMENT.to_owned(),
        state: PENDING.to_owned(),
        original_path: format!("{ATTACHMENTS_DIR}/{}", row.file_name),
        size: row.size,
        deleted_at: db::now_ms(),
        file_id: Some(row.id.clone()),
        payload: Some(payload),
    };
    insert_pending(&state.pool, &trash_row).await?;
    let dir = entry_dir(state, &trash_row.id);
    let blob = dir.join("blob");
    let thumb = dir.join("thumb");
    let files_blob = crate::files::file_path(&state.config, &row.id);
    let files_thumb = crate::files::thumb_path(&state.config, &row.id);
    let moved = (|| -> std::io::Result<()> {
        std::fs::create_dir(&dir)?;
        rename_no_replace(&files_blob, &blob)?;
        if exists_at(&files_thumb)
            && let Err(e) = rename_no_replace(&files_thumb, &thumb)
        {
            // thumb が動かせなければ blob を戻す
            rename_no_replace(&blob, &files_blob)?;
            return Err(e);
        }
        Ok(())
    })();
    if let Err(e) = moved {
        // 全部戻せたら、行と作りかけのフォルダを消す。戻せなかった（blob だけ trash にある）ときは
        // pending のまま残し、起動時の recover が完了させる（実体を失わない）
        if exists_at(&files_blob) && !exists_at(&blob) {
            let _ = std::fs::remove_dir_all(&dir);
            delete_row(&state.pool, &trash_row.id).await?;
        }
        return Err(io_app(e));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE files SET deleted_at = ?, has_thumb = 0 WHERE id = ?")
        .bind(trash_row.deleted_at)
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE shared_trash SET state = 'ready' WHERE id = ?")
        .bind(&trash_row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    announce(state, trash_row.original_path.clone());
    let active = namespace_active(state).await;
    Ok(entry_of(
        active,
        &Row {
            state: READY.to_owned(),
            ..trash_row
        },
    ))
}

// ---- 復元 ----

/// 元の場所へ戻す。戻した先のパス（共有フォルダの相対パス）を返す。
/// 同名があれば 409 `exists`（移動が失敗するので、先に見ない。消さずに残す）。
pub async fn restore(state: &SharedState, id: &str) -> AppResult<String> {
    let _guard = state.write_lock().await;
    let row = ready_row(state, id).await?;
    if row.kind == KIND_ATTACHMENT {
        return restore_attachment(state, row).await;
    }
    let segs = segments(&row.original_path);
    // 予約の名前（ルートの attachments）へは戻さない（実際のフォルダができてしまうため）
    if segs.first().is_some_and(|s| s == ATTACHMENTS_DIR) {
        return Err(conflict("exists", "この名前は添付の場所なので戻せません"));
    }
    let fs = SharedFs::new(state, "");
    let target = fs
        .real_path(&segs, true)
        .map_err(|_| conflict("invalid_name", "元の名前は使えないので戻せません"))?;
    if let Some((_, parent)) = segs.split_last() {
        let parent_path = fs
            .real_path(parent, true)
            .map_err(|_| conflict("parent_missing", "親のフォルダがありません"))?;
        let is_dir = std::fs::symlink_metadata(&parent_path)
            .map(|m| m.is_dir() && !m.file_type().is_symlink())
            .unwrap_or(false);
        if !is_dir {
            return Err(conflict("parent_missing", "親のフォルダがありません"));
        }
    }
    let dir = entry_dir(state, &row.id);
    let item = dir.join("item");
    set_state(&state.pool, &row.id, RESTORING).await?;
    if let Err(e) = rename_no_replace(&item, &target) {
        // 動いていないので、ゴミ箱の項目に戻す
        set_state(&state.pool, &row.id, READY).await?;
        return Err(match e.kind() {
            std::io::ErrorKind::NotFound => conflict("parent_missing", "親のフォルダがありません"),
            _ => io_app(e),
        });
    }
    delete_row(&state.pool, &row.id).await?;
    let _ = std::fs::remove_dir(&dir);
    announce(state, notify_path(&row));
    Ok(row.original_path)
}

async fn restore_attachment(state: &SharedState, row: Row) -> AppResult<String> {
    let payload: FileRow = serde_json::from_str(row.payload.as_deref().unwrap_or("null"))
        .map_err(AppError::internal)?;
    let fid = payload.id.clone();
    if store::live_by_key(&state.pool, &key(&payload.file_name))
        .await?
        .is_some_and(|other| other.id != fid)
    {
        return Err(conflict("exists", "同じ名前の添付があります"));
    }
    if store::get(&state.pool, &fid)
        .await?
        .is_some_and(|r| r.deleted_at.is_none())
    {
        return Err(conflict("exists", "同じ添付が、もう見えています"));
    }
    let dir = entry_dir(state, &row.id);
    let blob = dir.join("blob");
    let thumb = dir.join("thumb");
    let files_blob = crate::files::file_path(&state.config, &fid);
    let files_thumb = crate::files::thumb_path(&state.config, &fid);
    set_state(&state.pool, &row.id, RESTORING).await?;
    // 先に thumb、最後に blob（blob が戻った時点を「戻した」とみなす）。どちらも上書きしない
    let placed = (|| -> std::io::Result<()> {
        if exists_at(&thumb) {
            rename_no_replace(&thumb, &files_thumb)?;
        }
        if let Err(e) = rename_no_replace(&blob, &files_blob) {
            if exists_at(&files_thumb) && !exists_at(&thumb) {
                rename_no_replace(&files_thumb, &thumb)?;
            }
            return Err(e);
        }
        Ok(())
    })();
    if let Err(e) = placed {
        // 戻せなかった（thumb の戻しも失敗したら RESTORING のまま、起動時の recover に任せる）
        if !exists_at(&blob) || !exists_at(&files_thumb) {
            set_state(&state.pool, &row.id, READY).await?;
        }
        return Err(io_app(e));
    }
    finish_attachment_restore(state, &row, &payload).await?;
    announce(state, row.original_path.clone());
    Ok(row.original_path)
}

/// 添付の行を戻す（同じ ID）。行が残っていれば見える状態にし、無ければ投稿は作らずライブラリの添付として入れる。
async fn finish_attachment_restore(
    state: &SharedState,
    row: &Row,
    payload: &FileRow,
) -> AppResult<()> {
    let mut tx = state.pool.begin().await?;
    let present: Option<String> = sqlx::query_scalar("SELECT id FROM files WHERE id = ?")
        .bind(&payload.id)
        .fetch_optional(&mut *tx)
        .await?;
    if present.is_some() {
        sqlx::query(
            "UPDATE files SET deleted_at = NULL, has_thumb = ?,
                              library = CASE WHEN message_id IS NULL THEN 1 ELSE library END
             WHERE id = ?",
        )
        .bind(payload.has_thumb)
        .bind(&payload.id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO files (id, uploader_id, message_id, file_name, alias_key, mime, size, width, height,
                                has_thumb, library, deleted_at, first_posted_at, created_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)",
        )
        .bind(&payload.id)
        .bind(&payload.uploader_id)
        .bind(&payload.file_name)
        .bind(key(&payload.file_name))
        .bind(&payload.mime)
        .bind(payload.size)
        .bind(payload.width)
        .bind(payload.height)
        .bind(payload.has_thumb)
        .bind(payload.first_posted_at)
        .bind(payload.created_at)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM shared_trash WHERE id = ?")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = std::fs::remove_dir(entry_dir(state, &row.id));
    Ok(())
}

// ---- 完全に消す ----

/// ゴミ箱の項目を完全に消す（実体と行）。途中で止まったら `purging` のまま残し、起動時に続きを行う。
/// 通常の一覧が変わらなくても、変更の通知を配信する（他の端末のゴミ箱の一覧を読み直すため）。
pub async fn purge(state: &SharedState, id: &str) -> AppResult<()> {
    let _guard = state.write_lock().await;
    let row = ready_row(state, id).await?;
    set_state(&state.pool, &row.id, PURGING).await?;
    finish_purge(state, &row).await?;
    announce(state, notify_path(&row));
    Ok(())
}

/// 完全削除の続き（purge と recover が使う）。実体を消してから行を消す。何度呼んでもよい。
async fn finish_purge(state: &SharedState, row: &Row) -> AppResult<()> {
    let dir = entry_dir(state, &row.id);
    if row.kind == KIND_ATTACHMENT {
        for name in ["blob", "thumb"] {
            remove_if_exists(&dir.join(name))?;
        }
        let mut tx = state.pool.begin().await?;
        if let Some(fid) = &row.file_id {
            let refd = store::referencing_message(&mut tx, fid, None).await?;
            if refd.is_none() {
                sqlx::query("DELETE FROM files WHERE id = ? AND deleted_at IS NOT NULL")
                    .bind(fid)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        sqlx::query("DELETE FROM shared_trash WHERE id = ?")
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    } else {
        // フォルダの中身を消すのは時間がかかるので、非同期の処理の外で行う
        let item = dir.join("item");
        if exists_at(&item) {
            let is_dir = std::fs::symlink_metadata(&item).map_err(io_app)?.is_dir();
            if is_dir {
                crate::webdav::fs::remove_tree_blocking(item)
                    .await
                    .map_err(|_| AppError::internal("ゴミ箱の中身を消せません"))?;
            } else {
                std::fs::remove_file(&item).map_err(io_app)?;
            }
        }
        delete_row(&state.pool, &row.id).await?;
    }
    let _ = std::fs::remove_dir(&dir);
    Ok(())
}

fn remove_if_exists(path: &Path) -> AppResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_app(e)),
    }
}

// ---- 起動時の回復 ----

/// 起動時の回復（ルートを公開する前に一度だけ呼ぶ）。[`reconcile`] と同じ。
pub async fn recover(state: &SharedState) -> sqlx::Result<()> {
    let _guard = state.write_lock().await;
    reconcile(state).await
}

/// 途中で止まった項目を、行と実体の有無から一度だけ回復する。呼ぶ側は write_lock を持つこと。
/// 回復できたものは、元の path で `files.changed` を配信する（一覧・中身を読み直すため）。
/// 決められないものは `broken` にして消さない（ログに出す）。DB の一時的な失敗は、そのまま返す（再試行はしない）。
async fn reconcile(state: &SharedState) -> sqlx::Result<()> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, state, original_path, size, deleted_at, file_id, payload
         FROM shared_trash WHERE state <> 'ready' ORDER BY deleted_at, id",
    )
    .fetch_all(&state.pool)
    .await?;
    for row in rows {
        if row.state == BROKEN {
            tracing::error!(trash = %row.id, "ゴミ箱の項目が壊れています（消さずに残しています）");
            continue;
        }
        let result = if row.kind == KIND_ATTACHMENT {
            recover_attachment(state, &row).await
        } else {
            recover_shared(state, &row).await
        };
        match result {
            Ok(()) => {
                announce(state, notify_path(&row));
            }
            Err(RecoverError::Db(e)) => return Err(e),
            Err(RecoverError::Stuck(msg)) => {
                // 決められない＝消さずに broken にする（次の起動でも、人が見る）
                tracing::error!(trash = %row.id, "ゴミ箱の回復ができません（broken にして残します）: {msg}");
                set_state(&state.pool, &row.id, BROKEN).await?;
            }
        }
    }
    Ok(())
}

enum RecoverError {
    Db(sqlx::Error),
    Stuck(String),
}

impl From<sqlx::Error> for RecoverError {
    fn from(e: sqlx::Error) -> Self {
        RecoverError::Db(e)
    }
}

impl From<AppError> for RecoverError {
    fn from(e: AppError) -> Self {
        RecoverError::Stuck(format!("{e:?}"))
    }
}

impl From<std::io::Error> for RecoverError {
    fn from(e: std::io::Error) -> Self {
        RecoverError::Stuck(e.to_string())
    }
}

async fn recover_shared(state: &SharedState, row: &Row) -> Result<(), RecoverError> {
    let dir = entry_dir(state, &row.id);
    let item = dir.join("item");
    let original = state
        .config
        .shared_dir()
        .join(segments(&row.original_path).join("/"));
    let item_here = exists_at(&item);
    let orig_here = exists_at(&original);
    match (row.state.as_str(), item_here, orig_here) {
        // 動かす前に止まった（元がある）か、動かした後に止まった（項目だけ trash にある）
        (PENDING, true, false) => {
            set_state(&state.pool, &row.id, READY).await?;
            tracing::info!(trash = %row.id, "ゴミ箱の途中の項目を完了しました");
        }
        (PENDING, false, true) => {
            delete_row(&state.pool, &row.id).await?;
            let _ = std::fs::remove_dir(&dir);
            tracing::info!(trash = %row.id, "ゴミ箱へ入れる途中だったので、元のまま戻しました");
        }
        // 戻す途中: 項目が trash にあれば戻していない、元にあれば戻し終えている
        (RESTORING, true, false) => {
            set_state(&state.pool, &row.id, READY).await?;
            tracing::info!(trash = %row.id, "復元の途中だったので、ゴミ箱に残しました");
        }
        (RESTORING, false, true) => {
            delete_row(&state.pool, &row.id).await?;
            let _ = std::fs::remove_dir(&dir);
            tracing::info!(trash = %row.id, "復元の途中の項目を完了しました");
        }
        (PURGING, _, _) => finish_purge(state, row).await?,
        // 元にも trash にも無い、両方にある、ほかの状態: 決められないので消さない
        _ => {
            return Err(RecoverError::Stuck(format!(
                "状態 {} で、項目（trash: {item_here}, 元: {orig_here}）が一つに決まりません",
                row.state
            )));
        }
    }
    Ok(())
}

async fn recover_attachment(state: &SharedState, row: &Row) -> Result<(), RecoverError> {
    let dir = entry_dir(state, &row.id);
    let blob = dir.join("blob");
    let thumb = dir.join("thumb");
    let payload: Option<FileRow> = row
        .payload
        .as_deref()
        .and_then(|p| serde_json::from_str(p).ok());
    let fid = row
        .file_id
        .clone()
        .or(payload.as_ref().map(|p| p.id.clone()))
        .ok_or_else(|| RecoverError::Stuck("添付の ID が無い".into()))?;
    let files_blob = crate::files::file_path(&state.config, &fid);
    let files_thumb = crate::files::thumb_path(&state.config, &fid);
    let (in_trash_blob, in_files_blob) = (exists_at(&blob), exists_at(&files_blob));
    let (in_trash_thumb, in_files_thumb) = (exists_at(&thumb), exists_at(&files_thumb));
    if row.state == PENDING || row.state == RESTORING {
        // 本体（blob）が両方にある、またはサムネイルが両方にある: どちらを残すか決められない
        if (in_trash_blob && in_files_blob) || (in_trash_thumb && in_files_thumb) {
            return Err(RecoverError::Stuck(
                "添付の本体かサムネイルが、ゴミ箱と files の両方にある".into(),
            ));
        }
    }
    let Some(payload) = payload else {
        return Err(RecoverError::Stuck("添付の情報が読めない".into()));
    };
    match row.state.as_str() {
        PENDING => {
            if in_trash_blob {
                // blob は動かし終えている。サムネイルがあるなら、残りを動かして行を隠す
                if payload.has_thumb && !in_trash_thumb && !in_files_thumb {
                    return Err(RecoverError::Stuck("サムネイルが見つからない".into()));
                }
                if in_files_thumb && !in_trash_thumb {
                    rename_no_replace(&files_thumb, &thumb)?;
                }
                let mut tx = state.pool.begin().await?;
                sqlx::query(
                    "UPDATE files SET deleted_at = COALESCE(deleted_at, ?), has_thumb = 0 WHERE id = ?",
                )
                .bind(row.deleted_at)
                .bind(&fid)
                .execute(&mut *tx)
                .await?;
                sqlx::query("UPDATE shared_trash SET state = 'ready' WHERE id = ?")
                    .bind(&row.id)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                tracing::info!(trash = %row.id, "添付をゴミ箱へ入れる途中だったので、完了しました");
            } else if in_files_blob {
                delete_row(&state.pool, &row.id).await?;
                let _ = std::fs::remove_dir(&dir);
                tracing::info!(trash = %row.id, "添付をゴミ箱へ入れる前だったので、元のまま残しました");
            } else {
                return Err(RecoverError::Stuck("添付の本体が見つからない".into()));
            }
        }
        RESTORING => {
            if in_trash_blob {
                // blob がまだ戻っていない: サムネイルが戻っていれば、ゴミ箱へ戻してから ready にする
                if in_files_thumb && !in_trash_thumb {
                    rename_no_replace(&files_thumb, &thumb)?;
                }
                if payload.has_thumb && !exists_at(&thumb) {
                    return Err(RecoverError::Stuck("サムネイルが見つからない".into()));
                }
                set_state(&state.pool, &row.id, READY).await?;
                tracing::info!(trash = %row.id, "添付の復元の途中だったので、ゴミ箱に残しました");
            } else if in_files_blob {
                finish_attachment_restore(state, row, &payload).await?;
                tracing::info!(trash = %row.id, "添付の復元の途中を完了しました");
            } else {
                return Err(RecoverError::Stuck("添付の本体が見つからない".into()));
            }
        }
        PURGING => finish_purge(state, row).await?,
        _ => {
            return Err(RecoverError::Stuck(format!(
                "状態 {} を扱えない",
                row.state
            )));
        }
    }
    Ok(())
}

// ---- 仮想の `.trash`（共有フォルダのルートから見える、ゴミ箱の中身） ----
//
// 名前は `<ULID 26 文字>--<元の名前>`（同じ名前が複数あっても、ID で区別できる。ID は時刻で始まる部分が
// 同じことが多いので、先頭の数文字は使わない）。名前が 255 バイトを超えるときは、元の名前を切り詰めるが、
// 拡張子（16 バイト以下）は残す。どの行の名前かは、先頭の ID で行を引き、名前が一致するかを確かめて決める。

/// 仮想の名前（共有フォルダのルート直下）。
pub const NAMESPACE: &str = ".trash";
const ID_LEN: usize = 26;
const SEP: &str = "--";
const MAX_NAME: usize = 255;
const MAX_EXT: usize = 16;

static CONFLICT_WARNED: AtomicBool = AtomicBool::new(false);

/// 仮想の `.trash` が使えるか（要求ごとに一度だけ調べる。ブロックする読み取りは blocking の thread で行う）。
/// 実際のルート直下に同じ名前（ASCII の大文字小文字を区別せず。ファイル・リンクも含む）があれば使えない。
/// その場合は実際の項目をそのまま見せ、何も隠さず・動かさず・消さない。
/// 読めない項目が一つでもあれば、安全側（使えない）にする。警告は状態が変わったときだけ出す。
pub async fn namespace_active(state: &SharedState) -> bool {
    let dir = state.config.shared_dir();
    let conflict = tokio::task::spawn_blocking(move || {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return true;
        };
        rd.into_iter().any(|entry| match entry {
            Err(_) => true,
            Ok(e) => e
                .file_name()
                .to_str()
                .is_none_or(|n| n.eq_ignore_ascii_case(NAMESPACE)),
        })
    })
    .await
    .unwrap_or(true);
    if conflict {
        if !CONFLICT_WARNED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "共有フォルダに実際の `.trash` があるため、仮想のゴミ箱の名前は使いません（中身はそのまま）"
            );
        }
    } else {
        CONFLICT_WARNED.store(false, Ordering::Relaxed);
    }
    !conflict
}

/// 元の名前（区切りの最後）。
fn leaf(original_path: &str) -> &str {
    original_path.rsplit('/').next().unwrap_or(original_path)
}

/// 行の仮想の名前（決まり）。
pub fn alias_of(id: &str, original_path: &str) -> String {
    let budget = MAX_NAME - id.len() - SEP.len();
    format!("{id}{SEP}{}", shorten(leaf(original_path), budget))
}

/// 名前を `budget` バイト以下にする（文字の途中で切らない。拡張子は残す）。
fn shorten(name: &str, budget: usize) -> String {
    if name.len() <= budget {
        return name.to_owned();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= MAX_EXT && name.len() - i < budget => {
            (&name[..i], &name[i..])
        }
        _ => (name, ""),
    };
    let mut end = budget - ext.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ext}", &stem[..end])
}

/// 元のパスの区切りの列（復元の先の確認に使う）。
pub fn original_segs(row: &Row) -> Vec<String> {
    row.original_path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 添付の種類（添付のときだけ）。
pub fn attachment_mime(row: &Row) -> Option<String> {
    if row.kind != KIND_ATTACHMENT {
        return None;
    }
    let payload: FileRow = serde_json::from_str(row.payload.as_deref()?).ok()?;
    Some(payload.mime)
}

/// 仮想のゴミ箱の中の正規の path（`.trash/<名前>`）。`active` は、要求の最初に調べた結果。
pub fn trash_path_for(active: bool, row: &Row) -> Option<String> {
    active.then(|| format!("{NAMESPACE}/{}", alias_of(&row.id, &row.original_path)))
}

/// 仮想の名前から、完了した行を引く。先頭の ID（26 文字、UTF-8 の境界で取る）で行を探し、
/// 決まりの名前と完全に一致したものだけ。一致しない・無い・短すぎる名前は None（404）。
/// 一致したが途中（pending・restoring・purging）または壊れている（broken）は 403（直接の要求）。
/// 一覧には出さない（[`ready_rows`] は完了したものだけ）。
pub async fn by_alias(state: &SharedState, alias: &str) -> AppResult<Option<Row>> {
    let Some(id) = alias.get(..ID_LEN) else {
        return Ok(None);
    };
    settle(state).await?;
    let Some(row) = get_row(&state.pool, id).await? else {
        return Ok(None);
    };
    if alias_of(&row.id, &row.original_path) != alias {
        return Ok(None);
    }
    match row.state.as_str() {
        READY => Ok(Some(row)),
        BROKEN => Err(AppError::new(
            StatusCode::FORBIDDEN,
            "trash_broken",
            "中身が合わないため、ここからは操作できません",
        )),
        _ => Err(AppError::new(
            StatusCode::FORBIDDEN,
            "trash_busy",
            "処理の途中です。しばらくして再度試してください",
        )),
    }
}

/// `path` が、リンクでないこと（無い・リンクならどちらも NotFound。リンクは辿らない）。
fn no_link(path: &Path) -> FsResult<()> {
    match std::fs::symlink_metadata(path) {
        // リンクは、無いものとして隠す（外のものの存在も、中身も見せない）
        Ok(m) if m.file_type().is_symlink() => Err(FsError::NotFound),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(FsError::NotFound),
        Err(_) => Err(FsError::GeneralFailure),
    }
}

/// 行の中の実体（`rest` は項目の中の区切りの列）。安全のため、ID のフォルダ・項目（blob／item）・
/// 中の各区切りの、どれかがリンクなら拒否する（外のものは読めない）。添付は blob だけで、中には入れない。
pub fn real_of(state: &SharedState, row: &Row, rest: &[String]) -> FsResult<PathBuf> {
    let dir = entry_dir(state, &row.id);
    no_link(&dir)?;
    if row.kind == KIND_ATTACHMENT {
        let blob = dir.join("blob");
        no_link(&blob)?;
        return if rest.is_empty() {
            Ok(blob)
        } else {
            Err(FsError::NotFound)
        };
    }
    let mut p = dir.join("item");
    no_link(&p)?;
    for s in rest {
        if !crate::webdav::names::valid_name(s) {
            return Err(FsError::NotFound);
        }
        p.push(s);
        no_link(&p)?;
    }
    Ok(p)
}

/// 実体の場所の失敗を、利用者の API の形にする（リンクは 403、無いものは 404）。
fn fs_to_app(e: FsError) -> AppError {
    match e {
        FsError::NotFound => AppError::not_found("見つかりません"),
        FsError::Forbidden => AppError::forbidden("この場所は読めません"),
        _ => AppError::internal("ゴミ箱の中身を読めませんでした"),
    }
}

/// VFS の失敗を、dav-server の形にする（parent_missing は 404、途中・壊れた・403 は 403）。
pub fn vfs_err(e: AppError) -> FsError {
    match (e.status.as_u16(), e.code) {
        (404, _) | (409, "parent_missing") => FsError::NotFound,
        (409, "exists") => FsError::Exists,
        (403, _) | (409, _) => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

/// ゴミ箱の直下の項目（完了したもの）を一覧の形にする。`active` は、要求で調べた結果（ゴミ箱の中では真）。
/// 添付の ID（files 行）は出さない（削除された添付を、ID で読ませないため）。MIME は payload から。
/// 実体が無い・リンクのときは None（一覧から隠す）。
pub fn top_listing(
    state: &SharedState,
    row: &Row,
    active: bool,
) -> Option<crate::webdav::fs::Listed> {
    let real = real_of(state, row, &[]).ok()?;
    let m = std::fs::symlink_metadata(&real).ok()?;
    let entry = entry_of(active, row);
    Some(crate::webdav::fs::Listed::for_trash(
        alias_of(&row.id, &row.original_path),
        crate::webdav::fs::Meta::of_std(&m),
        attachment_mime(row),
        SharedTrashNode::Item { entry },
    ))
}

/// ゴミ箱の大きさ（`rest` が空ならゴミ箱の中身すべて、そうでなければ一つの項目の中）。
/// 実際のファイルの大きさを数える（行の大きさは使わない）。リンクは辿らず、外のものは数えない。
/// - 直下の項目（フォルダ）は、ゴミ箱の中身の一覧の一つとして、ゴミ箱の直下の大きさにだけ 1 フォルダとして数える。
/// - 要求したフォルダ（直下でも中でも）は、自分自身を数えない（配下だけ）。
///
/// 集計は blocking の thread で行う。
pub async fn size_of(state: &SharedState, rest: &[String]) -> AppResult<Usage> {
    // (実際の path, 直下の項目か, 添付か) の列を、先に作る（行の検査はここで）
    let mut targets: Vec<PathBuf> = Vec::new();
    let top_level = rest.is_empty();
    if let Some((alias, inner)) = rest.split_first() {
        let row = by_alias(state, alias)
            .await?
            .ok_or_else(|| AppError::not_found("見つかりません"))?;
        let p = real_of(state, &row, inner).map_err(fs_to_app)?;
        targets.push(p);
    } else {
        for row in ready_rows(state).await? {
            // 安全でない項目（リンクなど）は、数えず、一覧にも出さない
            if let Ok(p) = real_of(state, &row, &[]) {
                targets.push(p);
            }
        }
    }
    let total = tokio::task::spawn_blocking(move || -> std::io::Result<Usage> {
        let mut total = Usage::default();
        for p in targets {
            let m = match std::fs::symlink_metadata(&p) {
                Ok(m) if !m.file_type().is_symlink() => m,
                // リンク・消えたもの: 数えない
                Ok(_) => continue,
                Err(e) if top_level && e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if m.is_dir() {
                // フォルダ: 配下だけを数える（自分自身は含めない）
                total.add(usage(&p, &[])?);
                if top_level {
                    total.dirs += 1;
                }
            } else {
                total.size += m.len();
                total.files += 1;
            }
        }
        Ok(total)
    })
    .await
    .map_err(AppError::internal)?;
    total.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::not_found("見つかりません")
        } else {
            AppError::internal(e)
        }
    })
}
