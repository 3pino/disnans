//! 自分で設定するアバター（SPEC 3.3）。
//!
//! 画像を中央で正方形に切り抜き、256px の WebP にして `<data_dir>/avatars/<id>.webp` に置く。
//! 設定し直すたびに新しい ID にするので、配信する URL（`/api/avatars/{id}`）は長くキャッシュしてよい。
//! 消すと Tailscale のプロフィール画像に戻る。

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use disnans_shared::{ServerEvent, User};

use crate::config::Config;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::image_proc::{self, Kind};
use crate::state::AppState;
use crate::store::users;

/// アップロードできる画像の大きさの上限（変換前）。
pub const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

/// ファイル ID の形式（ULID）。パスに使うので厳密に確かめる。
pub fn is_valid_file_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

pub fn avatar_path(config: &Config, file_id: &str) -> PathBuf {
    config.avatars_dir().join(format!("{file_id}.webp"))
}

pub fn too_large() -> AppError {
    AppError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "avatar_too_large",
        format!(
            "アバターの画像は {} MB までです",
            MAX_UPLOAD_BYTES / 1024 / 1024
        ),
    )
}

/// 一時ファイルの画像をアバターにして `dest` に書く。時間がかかるので `spawn_blocking` の中で呼ぶこと。
fn convert(tmp: &Path, dest: &Path) -> AppResult<()> {
    let invalid = || {
        AppError::bad_request(
            "invalid_image",
            "画像を読めませんでした（JPEG / PNG / WebP / GIF などにしてください）",
        )
    };
    let format = match image_proc::detect(tmp) {
        Kind::Still(format) | Kind::Animated(format) => format,
        Kind::Other => return Err(invalid()),
    };
    // アニメーションは最初のフレームを使う
    let image = image_proc::decode(tmp, format).map_err(|_| invalid())?;
    let encoded = image_proc::avatar(&image).map_err(|_| invalid())?;
    std::fs::write(dest, &encoded.data)?;
    Ok(())
}

/// 一時ファイルの画像を自分のアバターにする。`tmp` はなくなる。
pub async fn set(state: &AppState, user: &User, tmp: PathBuf) -> AppResult<User> {
    let file_id = db::new_id();
    let dest = avatar_path(&state.config, &file_id);
    let dest_for_task = dest.clone();
    let tmp_for_task = tmp.clone();
    let converted =
        tokio::task::spawn_blocking(move || convert(&tmp_for_task, &dest_for_task)).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    if let Err(err) = converted.map_err(AppError::internal).and_then(|r| r) {
        remove_file(&dest).await;
        return Err(err);
    }

    let result = replace(state, user, Some(&file_id)).await;
    if result.is_err() {
        remove_file(&dest).await;
    }
    result
}

/// 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す。設定していなければ何もしない。
pub async fn clear(state: &AppState, user: &User) -> AppResult<User> {
    replace(state, user, None).await
}

/// アバターのファイル ID を差し替え、変わったら全員に `user.updated` を配信する。前のファイルは消す。
async fn replace(state: &AppState, user: &User, file_id: Option<&str>) -> AppResult<User> {
    let _guard = state.write_lock().await;
    let old = users::avatar_file(&state.pool, &user.id).await?;
    if old.is_none() && file_id.is_none() {
        return users::get(&state.pool, &user.id)
            .await?
            .ok_or_else(|| AppError::not_found("ユーザーが見つかりません"));
    }
    let updated = users::set_avatar_file(&state.pool, &user.id, file_id)
        .await?
        .ok_or_else(|| AppError::not_found("ユーザーが見つかりません"))?;
    if let Some(old) = old {
        remove_file(&avatar_path(&state.config, &old)).await;
    }
    tracing::info!(login_name = %user.login_name, custom = file_id.is_some(), "アバターを変更しました");
    state.hub.broadcast(&ServerEvent::UserUpdated {
        user: updated.clone(),
    });
    Ok(updated)
}

async fn remove_file(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!("ファイルを消せませんでした（{}）: {err}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_file_ids() {
        assert!(is_valid_file_id(&db::new_id()));
        for ng in [
            "",
            "../x",
            "01ARZ3NDEKTSV4RRFFQ69G5FA",
            "01arz3ndektsv4rrffq69g5fav",
        ] {
            assert!(!is_valid_file_id(ng), "{ng}");
        }
    }
}
