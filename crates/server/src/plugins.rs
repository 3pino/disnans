//! プラグインの配布・更新・削除（SPEC 9.2, 9.6）。
//!
//! ファイルは `<data_dir>/plugins/<id>/` に置く。サーバーはプラグインのコードを実行せず、
//! 保存して配るだけ。配布・更新・削除のたびに全員に `plugin.updated` / `plugin.removed` を配信する
//! （チャットにお知らせは流さない）。

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use disnans_shared::{PluginInfo, ServerEvent, User};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::plugins;

/// 配布できるファイル（この順に並べる）。
pub const FILE_NAMES: [&str; 4] = ["manifest.json", "main.js", "styles.css", "icon.svg"];
/// 必須のファイル。
const REQUIRED_FILES: [&str; 2] = ["manifest.json", "main.js"];
/// ファイルの合計サイズの上限。
pub const MAX_PACKAGE_BYTES: usize = 5 * 1024 * 1024;
/// アイコン（`icon.svg`）の上限。
const MAX_ICON_BYTES: usize = 64 * 1024;

/// manifest の各項目の最大文字数。
const MAX_NAME_CHARS: usize = 64;
const MAX_VERSION_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_AUTHOR_CHARS: usize = 64;
const MAX_ICON_CHARS: usize = 64;

/// プラグイン ID の形式（英小文字・数字・ハイフン、2〜32文字）。
pub fn is_valid_id(id: &str) -> bool {
    (2..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// ID の形式が正しくなければ `invalid_plugin_id`。
pub fn validate_id(id: &str) -> AppResult<()> {
    if !is_valid_id(id) {
        return Err(AppError::bad_request(
            "invalid_plugin_id",
            "プラグイン ID は英小文字・数字・ハイフンの 2〜32 文字にしてください",
        ));
    }
    Ok(())
}

/// 配布できるファイルなら、その Content-Type。
pub fn content_type(file_name: &str) -> Option<&'static str> {
    match file_name {
        "manifest.json" => Some("application/json"),
        "main.js" => Some("application/javascript; charset=utf-8"),
        "styles.css" => Some("text/css"),
        "icon.svg" => Some("image/svg+xml"),
        _ => None,
    }
}

pub fn plugin_dir(config: &Config, id: &str) -> PathBuf {
    config.plugins_dir().join(id)
}

/// (ファイル名, 中身) の一覧。
type Files = Vec<(&'static str, Vec<u8>)>;

/// アップロードされたファイル一式。名前は `FILE_NAMES` のどれか（`add` で確かめる）。
#[derive(Default)]
pub struct Package {
    files: Files,
    total: usize,
}

impl Package {
    /// ファイルを足す。名前が不正・重複している、合計が上限を超えたときは失敗する。
    pub fn add(&mut self, file_name: &str, data: Vec<u8>) -> AppResult<()> {
        let Some(&name) = FILE_NAMES.iter().find(|n| **n == file_name) else {
            return Err(AppError::bad_request(
                "invalid_file_name",
                format!(
                    "配布できないファイルです（{file_name}）。manifest.json / main.js / styles.css / icon.svg だけです"
                ),
            ));
        };
        if self.files.iter().any(|(n, _)| *n == name) {
            return Err(AppError::bad_request(
                "duplicate_file",
                format!("{name} が2つあります"),
            ));
        }
        if data.len() > self.remaining() {
            return Err(too_large());
        }
        if name == "icon.svg" {
            validate_icon_svg(&data)?;
        }
        self.total += data.len();
        self.files.push((name, data));
        Ok(())
    }

    /// あと何バイト足せるか（読み込み中に上限を確かめるのに使う）。
    pub fn remaining(&self) -> usize {
        MAX_PACKAGE_BYTES - self.total
    }

    fn file(&self, name: &str) -> Option<&[u8]> {
        self.files
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, d)| d.as_slice())
    }

    /// 必須のファイルと manifest を確かめ、`PluginInfo` を組み立てる（更新者と時刻は呼び出し側で入れる）。
    fn into_info(mut self, user: &User) -> AppResult<(PluginInfo, Files)> {
        for name in REQUIRED_FILES {
            if self.file(name).is_none() {
                return Err(AppError::bad_request(
                    "missing_file",
                    format!("{name} がありません"),
                ));
            }
        }
        let manifest = parse_manifest(self.file("manifest.json").unwrap_or_default())?;

        self.files
            .sort_by_key(|(n, _)| FILE_NAMES.iter().position(|f| f == n));
        let info = PluginInfo {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            author: manifest.author,
            min_api_version: manifest.min_api_version,
            icon: manifest.icon,
            has_icon: self.file("icon.svg").is_some(),
            files: self.files.iter().map(|(n, _)| (*n).to_owned()).collect(),
            hash: hash(&self.files),
            updated_by: user.id.clone(),
            updated_at: db::now_ms(),
        };
        Ok((info, self.files))
    }
}

/// `icon.svg` の中身を確かめる（64 KB まで、UTF-8、`<svg` を含む）。
fn validate_icon_svg(data: &[u8]) -> AppResult<()> {
    let invalid = |message: String| AppError::bad_request("invalid_icon", message);
    if data.len() > MAX_ICON_BYTES {
        return Err(invalid(format!(
            "icon.svg は {} KB までです",
            MAX_ICON_BYTES / 1024
        )));
    }
    let text = std::str::from_utf8(data)
        .map_err(|_| invalid("icon.svg は UTF-8 にしてください".into()))?;
    if !text.contains("<svg") {
        return Err(invalid("icon.svg が SVG ではありません".into()));
    }
    Ok(())
}

/// manifest の `icon`（Lucide のアイコン名）の形式（英小文字・数字・ハイフン、1〜64文字）。
fn is_valid_icon_name(name: &str) -> bool {
    (1..=MAX_ICON_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn too_large() -> AppError {
    AppError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "plugin_too_large",
        format!(
            "ファイルは合計 {} MB までです",
            MAX_PACKAGE_BYTES / 1024 / 1024
        ),
    )
}

/// manifest.json の中身（SPEC 9.2）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    author: Option<String>,
    min_api_version: Option<u32>,
    icon: Option<String>,
}

struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    min_api_version: u32,
    /// Lucide のアイコン名。空なら `None`。
    icon: Option<String>,
}

fn parse_manifest(data: &[u8]) -> AppResult<Manifest> {
    let invalid = |message: String| AppError::bad_request("invalid_manifest", message);
    let raw: RawManifest = serde_json::from_slice(data)
        .map_err(|e| invalid(format!("manifest.json を読めません: {e}")))?;

    let id = raw.id.unwrap_or_default();
    validate_id(&id)?;
    let field = |value: Option<String>, key: &str, max: usize, required: bool| {
        let value = value.unwrap_or_default().trim().to_owned();
        if required && value.is_empty() {
            return Err(invalid(format!("manifest.json に {key} がありません")));
        }
        if value.chars().count() > max {
            return Err(invalid(format!("{key} は {max} 文字までです")));
        }
        Ok(value)
    };
    let icon = raw
        .icon
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if let Some(icon) = &icon
        && !is_valid_icon_name(icon)
    {
        return Err(invalid(format!(
            "icon は Lucide のアイコン名（英小文字・数字・ハイフンの {MAX_ICON_CHARS} 文字まで）にしてください"
        )));
    }
    Ok(Manifest {
        id,
        name: field(raw.name, "name", MAX_NAME_CHARS, true)?,
        version: field(raw.version, "version", MAX_VERSION_CHARS, true)?,
        description: field(raw.description, "description", MAX_DESCRIPTION_CHARS, false)?,
        author: field(raw.author, "author", MAX_AUTHOR_CHARS, false)?,
        min_api_version: raw.min_api_version.unwrap_or(1),
        icon,
    })
}

/// ファイル名と中身の SHA-256（16進）。名前と長さも混ぜて、ファイルの境目をはっきりさせる。
fn hash(files: &[(&str, Vec<u8>)]) -> String {
    let mut hasher = Sha256::new();
    for (name, data) in files {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update((data.len() as u64).to_le_bytes());
        hasher.update(data);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 配布・更新する。ファイルは一時ディレクトリに書いてから入れ替え、途中で失敗しても前のものが残るようにする。
pub async fn install(state: &AppState, user: &User, package: Package) -> AppResult<PluginInfo> {
    let (info, files) = package.into_info(user)?;

    // ロックの外で一時ディレクトリに書いておく
    let staging = state
        .config
        .tmp_dir()
        .join(format!("plugin-{}", db::new_id()));
    let written = async {
        tokio::fs::create_dir_all(&staging).await?;
        for (name, data) in &files {
            tokio::fs::write(staging.join(name), data).await?;
        }
        std::io::Result::Ok(())
    }
    .await;
    if let Err(err) = written {
        remove_dir(&staging).await;
        return Err(err.into());
    }

    let _guard = state.write_lock().await;
    let mut tx = state.pool.begin().await?;
    plugins::upsert(&mut tx, &info).await?;

    // DB をコミットする直前にファイルを入れ替える。コミットに失敗したら元に戻す
    let dest = plugin_dir(&state.config, &info.id);
    let old = match swap_in(&staging, &dest).await {
        Ok(old) => old,
        Err(err) => {
            remove_dir(&staging).await;
            return Err(err.into());
        }
    };
    if let Err(err) = tx.commit().await {
        restore(&dest, old.as_deref()).await;
        return Err(err.into());
    }
    if let Some(old) = old {
        remove_dir(&old).await;
    }
    tracing::info!(id = %info.id, version = %info.version, user = %user.login_name, "プラグインを配布しました");

    state.hub.broadcast(&ServerEvent::PluginUpdated {
        plugin: info.clone(),
    });
    Ok(info)
}

/// 削除する。セッションとカードは残す。
pub async fn remove(state: &AppState, user: &User, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let _guard = state.write_lock().await;
    if plugins::get(&state.pool, id).await?.is_none() {
        return Err(AppError::not_found("プラグインが見つかりません"));
    }

    let mut tx = state.pool.begin().await?;
    plugins::delete(&mut tx, id).await?;
    tx.commit().await?;

    remove_dir(&plugin_dir(&state.config, id)).await;
    tracing::info!(id, user = %user.login_name, "プラグインを削除しました");

    state.hub.broadcast(&ServerEvent::PluginRemoved {
        plugin_id: id.to_owned(),
    });
    Ok(())
}

/// `staging` を `dest` に移す。`dest` がすでにあれば脇に退け、その場所を返す（コミット後に消す）。
async fn swap_in(staging: &Path, dest: &Path) -> std::io::Result<Option<PathBuf>> {
    let old = if tokio::fs::try_exists(dest).await? {
        let old = staging.with_extension("old");
        tokio::fs::rename(dest, &old).await?;
        Some(old)
    } else {
        None
    };
    if let Err(err) = tokio::fs::rename(staging, dest).await {
        if let Some(old) = &old {
            let _ = tokio::fs::rename(old, dest).await;
        }
        return Err(err);
    }
    Ok(old)
}

/// `swap_in` を取り消す（新しいほうを消し、退けておいたものを戻す）。
async fn restore(dest: &Path, old: Option<&Path>) {
    remove_dir(dest).await;
    if let Some(old) = old
        && let Err(err) = tokio::fs::rename(old, dest).await
    {
        tracing::error!(
            "プラグインのファイルを元に戻せませんでした（{}）: {err}",
            dest.display()
        );
    }
}

async fn remove_dir(path: &Path) {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(
            "ディレクトリを消せませんでした（{}）: {err}",
            path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids() {
        for ok in ["dice", "a1", "my-plugin-2", &"x".repeat(32)] {
            assert!(is_valid_id(ok), "{ok}");
        }
        for ng in ["", "a", "Dice", "dice_1", "../x", "ダイス", &"x".repeat(33)] {
            assert!(!is_valid_id(ng), "{ng}");
        }
    }

    #[test]
    fn parses_manifest_with_defaults() {
        let m = parse_manifest(r#"{"id":"dice","name":" ダイス ","version":"1.0.0"}"#.as_bytes())
            .ok()
            .unwrap();
        assert_eq!(m.name, "ダイス");
        assert_eq!(m.description, "");
        assert_eq!(m.author, "");
        assert_eq!(m.min_api_version, 1);

        let err = |json: &str| parse_manifest(json.as_bytes()).err().unwrap().code;
        assert_eq!(err(r#"{"id":"dice","version":"1"}"#), "invalid_manifest");
        assert_eq!(
            err(r#"{"id":"Dice","name":"a","version":"1"}"#),
            "invalid_plugin_id"
        );
        assert_eq!(err("not json"), "invalid_manifest");
    }

    #[test]
    fn parses_manifest_icon() {
        let icon = |json: &str| parse_manifest(json.as_bytes()).map(|m| m.icon);
        let base = r#""id":"dice","name":"a","version":"1""#;
        assert_eq!(icon(&format!("{{{base}}}")).ok().unwrap(), None);
        assert_eq!(
            icon(&format!(r#"{{{base},"icon":" "}}"#)).ok().unwrap(),
            None
        );
        assert_eq!(
            icon(&format!(r#"{{{base},"icon":"dice-5"}}"#))
                .ok()
                .unwrap(),
            Some("dice-5".into())
        );
        for ng in ["Dice", "dice_5", "<svg>", &"x".repeat(65)] {
            let err = icon(&format!(r#"{{{base},"icon":"{ng}"}}"#)).err().unwrap();
            assert_eq!(err.code, "invalid_manifest", "{ng}");
        }
    }

    #[test]
    fn validates_icon_svg() {
        assert!(validate_icon_svg(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_ok());
        let err = |data: &[u8]| validate_icon_svg(data).err().unwrap().code;
        assert_eq!(err(b"<html></html>"), "invalid_icon");
        assert_eq!(err(&[0xff, 0xfe, b'<']), "invalid_icon");
        let mut big = b"<svg>".to_vec();
        big.resize(64 * 1024 + 1, b' ');
        assert_eq!(err(&big), "invalid_icon");
    }
}
