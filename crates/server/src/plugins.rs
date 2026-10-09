//! プラグイン・テーマの配布・更新・削除（SPEC 9.2, 9.6, 9.10）。
//!
//! ファイルは `<data_dir>/plugins/<id>/` に置く。サーバーはプラグインのコードを実行せず、
//! 保存して配るだけ。配布・更新・削除のたびに `plugin.updated` / `plugin.removed` を配信する
//! （チャットにお知らせは流さない）。
//!
//! 配布の範囲は「みんな」（public）か「自分だけ」（private）。自分だけのものは持ち主にだけ見え、
//! イベントも持ち主の接続にだけ送る。ID はプラグインとテーマ、みんなのものと自分だけのものを通して一意。

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use disnans_shared::{PluginInfo, PluginKind, PluginVisibility, ServerEvent, User};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::plugins;

/// 配布できるファイル（この順に並べる）。
pub const FILE_NAMES: [&str; 5] = [
    "manifest.json",
    "main.js",
    "styles.css",
    "theme.css",
    "icon.svg",
];
/// プラグインのファイル（必須, 任意）。
const PLUGIN_FILES: (&[&str], &[&str]) =
    (&["manifest.json", "main.js"], &["styles.css", "icon.svg"]);
/// テーマのファイル（必須, 任意）。JS は置けない。
const THEME_FILES: (&[&str], &[&str]) = (&["manifest.json", "theme.css"], &["icon.svg"]);
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
        "styles.css" | "theme.css" => Some("text/css"),
        "icon.svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// 配布できるファイルの説明（エラーの文言に使う）。
pub const ALLOWED_FILES_TEXT: &str = "manifest.json / main.js / styles.css / theme.css / icon.svg";

/// `user_id` に見えるか（みんなのものか、自分だけのものの持ち主か）。
pub fn is_visible(info: &PluginInfo, user_id: &str) -> bool {
    match info.visibility {
        PluginVisibility::Public => true,
        PluginVisibility::Private => info.owner.as_deref() == Some(user_id),
    }
}

/// multipart の `visibility`（`public` / `private`）を読む。
pub fn parse_visibility(value: &str) -> AppResult<PluginVisibility> {
    match value.trim() {
        "public" => Ok(PluginVisibility::Public),
        "private" => Ok(PluginVisibility::Private),
        _ => Err(AppError::bad_request(
            "invalid_visibility",
            "visibility は public か private にしてください",
        )),
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
                format!("配布できないファイルです（{file_name}）。{ALLOWED_FILES_TEXT} だけです"),
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

    /// manifest と、種類ごとの必須のファイル・置けないファイルを確かめ、`PluginInfo` を組み立てる。
    fn into_info(
        mut self,
        user: &User,
        visibility: PluginVisibility,
    ) -> AppResult<(PluginInfo, Files)> {
        let Some(manifest) = self.file("manifest.json") else {
            return Err(AppError::bad_request(
                "missing_file",
                "manifest.json がありません",
            ));
        };
        let manifest = parse_manifest(manifest)?;
        let (required, optional) = match manifest.kind {
            PluginKind::Plugin => PLUGIN_FILES,
            PluginKind::Theme => THEME_FILES,
        };
        for name in required {
            if self.file(name).is_none() {
                return Err(AppError::bad_request(
                    "missing_file",
                    format!("{name} がありません"),
                ));
            }
        }
        if let Some((name, _)) = self
            .files
            .iter()
            .find(|(n, _)| !required.contains(n) && !optional.contains(n))
        {
            let kind = match manifest.kind {
                PluginKind::Plugin => "プラグイン",
                PluginKind::Theme => "テーマ",
            };
            return Err(AppError::bad_request(
                "invalid_file_name",
                format!(
                    "{kind}には {name} を置けません（{} だけです）",
                    [required, optional].concat().join(" / ")
                ),
            ));
        }

        self.files
            .sort_by_key(|(n, _)| FILE_NAMES.iter().position(|f| f == n));
        let info = PluginInfo {
            id: manifest.id,
            kind: manifest.kind,
            visibility,
            owner: match visibility {
                PluginVisibility::Public => None,
                PluginVisibility::Private => Some(user.id.clone()),
            },
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
    /// `plugin`（省略時）か `theme`。
    #[serde(rename = "type")]
    kind: Option<String>,
}

struct Manifest {
    id: String,
    kind: PluginKind,
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
    let kind = match raw.kind.as_deref().map(str::trim) {
        None | Some("plugin") => PluginKind::Plugin,
        Some("theme") => PluginKind::Theme,
        Some(other) => {
            return Err(invalid(format!(
                "type は \"plugin\" か \"theme\" にしてください（{other}）"
            )));
        }
    };
    Ok(Manifest {
        id,
        kind,
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
///
/// 同じ ID のものがあれば上書きする。ただし、ほかの人の自分だけのものは上書きできない（`409 plugin_id_taken`）。
/// 範囲は配布し直すたびに選び直せる（みんなのものを自分だけにすると、ほかの人からは削除されたように見える）。
pub async fn install(
    state: &AppState,
    user: &User,
    package: Package,
    visibility: PluginVisibility,
) -> AppResult<PluginInfo> {
    let (info, files) = package.into_info(user, visibility)?;

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
    let prev = match plugins::get(&state.pool, &info.id).await {
        Ok(prev) => prev,
        Err(err) => {
            remove_dir(&staging).await;
            return Err(err.into());
        }
    };
    if let Some(prev) = &prev
        && !is_visible(prev, &user.id)
    {
        remove_dir(&staging).await;
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "plugin_id_taken",
            format!(
                "ID「{}」はほかの人が使っています。manifest.json の id を変えてください",
                info.id
            ),
        ));
    }
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
    tracing::info!(id = %info.id, version = %info.version, visibility = ?info.visibility, user = %user.login_name, "プラグインを配布しました");

    let updated = ServerEvent::PluginUpdated {
        plugin: info.clone(),
    };
    match info.visibility {
        PluginVisibility::Public => state.hub.broadcast(&updated),
        PluginVisibility::Private => {
            state.hub.send_to_user(&user.id, &updated);
            // みんなのものを自分だけにしたら、ほかの人からは消える
            if prev.is_some_and(|p| p.visibility == PluginVisibility::Public) {
                state.hub.broadcast_except_user(
                    &ServerEvent::PluginRemoved {
                        plugin_id: info.id.clone(),
                    },
                    &user.id,
                );
            }
        }
    }
    Ok(info)
}

/// 削除する。セッションとカードは残す。自分だけのものは持ち主だけが消せる（ほかの人には 404）。
pub async fn remove(state: &AppState, user: &User, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let _guard = state.write_lock().await;
    let Some(info) = plugins::get(&state.pool, id)
        .await?
        .filter(|p| is_visible(p, &user.id))
    else {
        return Err(AppError::not_found("プラグインが見つかりません"));
    };

    let mut tx = state.pool.begin().await?;
    plugins::delete(&mut tx, id).await?;
    tx.commit().await?;

    remove_dir(&plugin_dir(&state.config, id)).await;
    tracing::info!(id, user = %user.login_name, "プラグインを削除しました");

    let removed = ServerEvent::PluginRemoved {
        plugin_id: id.to_owned(),
    };
    match info.visibility {
        PluginVisibility::Public => state.hub.broadcast(&removed),
        PluginVisibility::Private => state.hub.send_to_user(&user.id, &removed),
    }
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
    fn parses_manifest_type() {
        let kind = |json: &str| parse_manifest(json.as_bytes()).map(|m| m.kind);
        let base = r#""id":"sakura","name":"a","version":"1""#;
        assert_eq!(kind(&format!("{{{base}}}")).ok(), Some(PluginKind::Plugin));
        assert_eq!(
            kind(&format!(r#"{{{base},"type":"plugin"}}"#)).ok(),
            Some(PluginKind::Plugin)
        );
        assert_eq!(
            kind(&format!(r#"{{{base},"type":"theme"}}"#)).ok(),
            Some(PluginKind::Theme)
        );
        let err = kind(&format!(r#"{{{base},"type":"skin"}}"#)).err().unwrap();
        assert_eq!(err.code, "invalid_manifest");
    }

    #[test]
    fn parses_visibility() {
        assert_eq!(
            parse_visibility("public").ok(),
            Some(PluginVisibility::Public)
        );
        assert_eq!(
            parse_visibility("private").ok(),
            Some(PluginVisibility::Private)
        );
        assert_eq!(
            parse_visibility("friends").err().unwrap().code,
            "invalid_visibility"
        );
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
