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

use axum::http::StatusCode;
use disnans_shared::{ServerEvent, SharedKind, SharedTrashEntry};
use sqlx::SqlitePool;

use crate::attachment_names::key;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::noreplace::rename_no_replace;
use crate::state::SharedState;
use crate::store::files::{self as store, FileRow};
use crate::webdav::fs::{SharedFs, rel};
use crate::webdav::tree::ATTACHMENTS_DIR;

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

fn kind_of(row: &Row) -> SharedKind {
    if row.kind == KIND_DIR {
        SharedKind::Dir
    } else {
        SharedKind::File
    }
}

fn entry_of(row: &Row) -> SharedTrashEntry {
    SharedTrashEntry {
        id: row.id.clone(),
        original_path: row.original_path.clone(),
        kind: kind_of(row),
        size: row.size.max(0) as u64,
        deleted_at: row.deleted_at,
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

/// 一覧（完了したものだけ）。途中の行があれば、ロックの中で一度だけ回復してから読む。
/// 途中の操作（ロックを持つ）とは競わない。DB が戻っていれば、再起動なしで ready になる。
/// 途中のものと broken は出さない。
pub async fn list(state: &SharedState) -> AppResult<Vec<SharedTrashEntry>> {
    if has_unfinished(&state.pool).await? {
        let _guard = state.write_lock().await;
        // ロックを待つ間に、別の操作が終わっているかもしれないので、改めて確かめる
        if has_unfinished(&state.pool).await? {
            reconcile(state).await?;
        }
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, state, original_path, size, deleted_at, file_id, payload
         FROM shared_trash WHERE state = 'ready' ORDER BY deleted_at DESC, id DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.iter().map(entry_of).collect())
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
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: notify_path(&row),
    });
    Ok(entry_of(&Row {
        state: READY.to_owned(),
        ..row
    }))
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
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: trash_row.original_path.clone(),
    });
    Ok(entry_of(&Row {
        state: READY.to_owned(),
        ..trash_row
    }))
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
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: notify_path(&row),
    });
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
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: row.original_path.clone(),
    });
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
    state.hub.broadcast(&ServerEvent::FilesChanged {
        path: notify_path(&row),
    });
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
                state.hub.broadcast(&ServerEvent::FilesChanged {
                    path: notify_path(&row),
                });
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
