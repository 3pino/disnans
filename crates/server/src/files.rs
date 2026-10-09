//! アップロードされたファイルの保存・削除。
//!
//! 保存先は `<data_dir>/files/<id>`（本体）と `<data_dir>/files/<id>.thumb`（サムネイル）。
//! アップロード中は `<data_dir>/tmp/` に書き、終わったら移す。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::config::Config;
use crate::db;
use crate::image_proc::{self, Kind};
use crate::state::SharedState;
use crate::store::files as file_store;

/// 投稿されないまま、この時間が過ぎたファイルは消す。
pub const ORPHAN_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// 投稿されていないファイルを探す間隔。
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub fn file_path(config: &Config, id: &str) -> PathBuf {
    config.files_dir().join(id)
}

pub fn thumb_path(config: &Config, id: &str) -> PathBuf {
    config.files_dir().join(format!("{id}.thumb"))
}

/// 保存したファイルの情報。
#[derive(Debug)]
pub struct Stored {
    pub file_name: String,
    pub mime: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub has_thumb: bool,
}

/// 一時ファイルを、種類に応じて変換して保存する。`tmp` はなくなる。
///
/// 時間がかかるので `spawn_blocking` の中で呼ぶこと。
pub fn store_upload(
    tmp: &Path,
    dest: &Path,
    thumb: &Path,
    file_name: String,
    mime: String,
) -> std::io::Result<Stored> {
    let kind = image_proc::detect(tmp);
    if let Kind::Still(format) = kind {
        match convert_still(tmp, dest, thumb, format) {
            Ok((size, width, height)) => {
                std::fs::remove_file(tmp)?;
                return Ok(Stored {
                    file_name: webp_file_name(&file_name),
                    mime: "image/webp".into(),
                    size,
                    width: Some(width),
                    height: Some(height),
                    has_thumb: true,
                });
            }
            Err(err) => {
                // 壊れた画像などは、変換せずにふつうのファイルとして保存する
                tracing::warn!(file_name = %file_name, "画像を変換できなかったので、そのまま保存します: {err}");
                let _ = std::fs::remove_file(dest);
                let _ = std::fs::remove_file(thumb);
            }
        }
    }

    std::fs::rename(tmp, dest)?;
    let size = std::fs::metadata(dest)?.len();

    match kind {
        Kind::Animated(format) => {
            // 本体はそのまま。サムネイルは最初のフレームから作る（作れなくても保存は続ける）
            let preview = image_proc::decode(dest, format)
                .map_err(|e| e.to_string())
                .and_then(|image| {
                    let encoded = image_proc::thumbnail(&image)?;
                    std::fs::write(thumb, &encoded.data).map_err(|e| e.to_string())?;
                    Ok((image.width(), image.height()))
                });
            let (size_wh, has_thumb) = match preview {
                Ok(wh) => (Some(wh), true),
                Err(err) => {
                    tracing::warn!(file_name = %file_name, "アニメーション画像のサムネイルを作れませんでした: {err}");
                    (None, false)
                }
            };
            Ok(Stored {
                file_name,
                mime: format.to_mime_type().into(),
                size,
                width: size_wh.map(|(w, _)| w),
                height: size_wh.map(|(_, h)| h),
                has_thumb,
            })
        }
        _ => Ok(Stored {
            file_name,
            mime,
            size,
            width: None,
            height: None,
            has_thumb: false,
        }),
    }
}

/// 静止画を WebP にして保存し、（サイズ, 幅, 高さ）を返す。
fn convert_still(
    tmp: &Path,
    dest: &Path,
    thumb: &Path,
    format: image::ImageFormat,
) -> Result<(u64, u32, u32), String> {
    let image = image_proc::decode(tmp, format).map_err(|e| e.to_string())?;
    let full = image_proc::convert(&image)?;
    let small = image_proc::thumbnail(&image)?;
    std::fs::write(dest, &full.data).map_err(|e| e.to_string())?;
    std::fs::write(thumb, &small.data).map_err(|e| e.to_string())?;
    Ok((full.data.len() as u64, full.width, full.height))
}

/// 変換後のファイル名（拡張子を `.webp` にする）。
fn webp_file_name(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    format!("{stem}.webp")
}

/// クライアントから送られたファイル名を、保存・表示しても安全な形にする。
pub fn sanitize_file_name(name: Option<&str>) -> String {
    const MAX_CHARS: usize = 200;
    let name = name.unwrap_or_default();
    // パスの区切りより後ろだけを使う
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".into()
    } else {
        cleaned.to_owned()
    }
}

/// 保存したファイル（本体とサムネイル）を消す。なければ何もしない。
pub async fn remove_stored(config: &Config, ids: &[String]) {
    for id in ids {
        for path in [file_path(config, id), thumb_path(config, id)] {
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    tracing::warn!("ファイルを消せませんでした（{}）: {err}", path.display())
                }
            }
        }
    }
}

/// 投稿されていない古いファイルを消す。
pub async fn cleanup_orphans(state: &SharedState) -> Result<usize, sqlx::Error> {
    let before = db::now_ms() - ORPHAN_TTL.as_millis() as i64;
    let ids = file_store::delete_orphans(&state.pool, before).await?;
    remove_stored(&state.config, &ids).await;
    Ok(ids.len())
}

/// `cleanup_orphans` を定期的に実行するタスクを起こす。
pub fn spawn_cleanup_task(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CLEANUP_INTERVAL);
        loop {
            interval.tick().await;
            match cleanup_orphans(&state).await {
                Ok(0) => {}
                Ok(n) => tracing::info!("投稿されなかったファイルを {n} 件削除しました"),
                Err(err) => tracing::error!("投稿されなかったファイルの削除に失敗しました: {err}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name(Some("../../etc/passwd")), "passwd");
        assert_eq!(
            sanitize_file_name(Some("C:\\Users\\a\\写真.jpg")),
            "写真.jpg"
        );
        assert_eq!(sanitize_file_name(Some("a\nb.txt")), "ab.txt");
        assert_eq!(sanitize_file_name(Some("..")), "file");
        assert_eq!(sanitize_file_name(None), "file");
    }

    #[test]
    fn renames_to_webp() {
        assert_eq!(webp_file_name("IMG_0001.JPG"), "IMG_0001.webp");
        assert_eq!(webp_file_name("noext"), "noext.webp");
    }
}
