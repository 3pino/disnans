//! プラグインの配布・更新・削除（SPEC 9.2, 9.6）。
//!
//! ファイルは `<data_dir>/plugins/<id>/` に置く。サーバーはプラグインのコードを実行せず、
//! 保存して配るだけ。配布・更新・削除のたびに全員に `plugin.updated` / `plugin.removed` を配信し、
//! 操作した人の名前でメインチャットにお知らせを流す。

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use disnans_shared::{PluginInfo, ServerEvent, User};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::chat;
use crate::config::Config;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::{messages, plugins};

/// 配布できるファイル（この順に並べる）。
pub const FILE_NAMES: [&str; 3] = ["manifest.json", "main.js", "styles.css"];
/// 必須のファイル。
const REQUIRED_FILES: [&str; 2] = ["manifest.json", "main.js"];
/// ファイルの合計サイズの上限。
pub const MAX_PACKAGE_BYTES: usize = 5 * 1024 * 1024;

/// manifest の各項目の最大文字数。
const MAX_NAME_CHARS: usize = 64;
const MAX_VERSION_CHARS: usize = 32;
const MAX_DESCRIPTION_CHARS: usize = 500;
const MAX_AUTHOR_CHARS: usize = 64;

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
                    "配布できないファイルです（{file_name}）。manifest.json / main.js / styles.css だけです"
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
            files: self.files.iter().map(|(n, _)| (*n).to_owned()).collect(),
            hash: hash(&self.files),
            updated_by: user.id.clone(),
            updated_at: db::now_ms(),
        };
        Ok((info, self.files))
    }
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
}

struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    min_api_version: u32,
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
    Ok(Manifest {
        id,
        name: field(raw.name, "name", MAX_NAME_CHARS, true)?,
        version: field(raw.version, "version", MAX_VERSION_CHARS, true)?,
        description: field(raw.description, "description", MAX_DESCRIPTION_CHARS, false)?,
        author: field(raw.author, "author", MAX_AUTHOR_CHARS, false)?,
        min_api_version: raw.min_api_version.unwrap_or(1),
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
    let previous = plugins::get(&state.pool, &info.id).await?;
    let body = match &previous {
        None => format!(
            "プラグイン「{}」{} を配布しました",
            info.name,
            v(&info.version)
        ),
        Some(prev) if prev.version != info.version => format!(
            "プラグイン「{}」を更新しました（{} → {}）",
            info.name,
            v(&prev.version),
            v(&info.version)
        ),
        Some(_) => format!(
            "プラグイン「{}」{} を更新しました",
            info.name,
            v(&info.version)
        ),
    };
    let row = chat::new_row(&user.id, None, body);

    let mut tx = state.pool.begin().await?;
    plugins::upsert(&mut tx, &info).await?;
    messages::insert(&mut tx, &row).await?;

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
    chat::broadcast_created(state, &row.id, None).await?;
    Ok(info)
}

/// 削除する。セッションとカードは残す。
pub async fn remove(state: &AppState, user: &User, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let _guard = state.write_lock().await;
    let info = plugins::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("プラグインが見つかりません"))?;
    let row = chat::new_row(
        &user.id,
        None,
        format!("プラグイン「{}」を削除しました", info.name),
    );

    let mut tx = state.pool.begin().await?;
    plugins::delete(&mut tx, id).await?;
    messages::insert(&mut tx, &row).await?;
    tx.commit().await?;

    remove_dir(&plugin_dir(&state.config, id)).await;
    tracing::info!(id, user = %user.login_name, "プラグインを削除しました");

    state.hub.broadcast(&ServerEvent::PluginRemoved {
        plugin_id: id.to_owned(),
    });
    chat::broadcast_created(state, &row.id, None).await?;
    Ok(())
}

/// バージョンの表示（`1.0.0` → `v1.0.0`。もともと `v` が付いていればそのまま）。
fn v(version: &str) -> String {
    if version.starts_with(['v', 'V']) {
        version.to_owned()
    } else {
        format!("v{version}")
    }
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
    fn formats_versions() {
        assert_eq!(v("1.0.0"), "v1.0.0");
        assert_eq!(v("v2"), "v2");
    }
}
