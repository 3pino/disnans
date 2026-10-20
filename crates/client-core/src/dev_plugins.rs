//! 開発用フォルダのプラグイン・テーマの走査と読み込み（GUI と CLI で共通。通信には依存しない）。
//!
//! 開発用フォルダの中の、サブフォルダ1つが1つのプラグイン（またはテーマ）。
//! フロントエンドは1秒ごとに `dev_plugins_scan` で更新時刻を見て、変わったものだけ `dev_plugin_read` で読み直す。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// 読むファイル（配布できるのもこれだけ）
pub const FILES: [&str; 5] = [
    "manifest.json",
    "main.js",
    "styles.css",
    "theme.css",
    "icon.svg",
];

/// 1つのプラグインの合計の上限（サーバーの配布の上限と同じ 5 MB）
const MAX_TOTAL: u64 = 5 * 1024 * 1024;

/// フォルダ1つ分の様子（中身は含まない）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPluginStat {
    /// サブフォルダの名前
    pub folder: String,
    /// FILES のうち、あるもの
    pub files: Vec<String>,
    /// ファイルの更新時刻（ミリ秒）と大きさから作った値。変わったら読み直す
    pub stamp: String,
}

/// フォルダ1つ分の中身
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPluginFiles {
    pub folder: String,
    pub manifest: Option<String>,
    pub main: Option<String>,
    pub styles: Option<String>,
    /// テーマの CSS（テーマのときだけ）
    pub theme: Option<String>,
    /// プラグインのアイコン（任意。24x24 の SVG）
    pub icon: Option<String>,
    pub stamp: String,
}

fn stat_folder(dir: &Path) -> (Vec<String>, String) {
    let mut files = Vec::new();
    let mut stamp = String::new();
    for name in FILES {
        let Ok(meta) = fs::metadata(dir.join(name)) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        stamp.push_str(&format!("{name}:{mtime}:{};", meta.len()));
        files.push(name.to_owned());
    }
    (files, stamp)
}

/// サブフォルダの名前を確かめる（`..` や区切り文字で外に出ないように）
fn sub_dir(dir: &str, folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty() || folder == "." || folder == ".." || folder.contains(['/', '\\']) {
        return Err(format!("フォルダの名前が正しくありません: {folder}"));
    }
    Ok(Path::new(dir).join(folder))
}

/// 開発用フォルダの中のサブフォルダを並べる。`manifest.json` か `main.js` があるものだけ
pub fn scan(dir: &str) -> Result<Vec<DevPluginStat>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("フォルダを開けません（{dir}）: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(folder) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // 隠しフォルダ（.git など）は見ない
        if folder.starts_with('.') {
            continue;
        }
        let (files, stamp) = stat_folder(&path);
        if !files.iter().any(|f| f == "manifest.json" || f == "main.js") {
            continue;
        }
        out.push(DevPluginStat {
            folder,
            files,
            stamp,
        });
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}

/// サブフォルダ1つのファイル（FILES）を読む
pub fn read_folder(dir: &str, folder: &str) -> Result<DevPluginFiles, String> {
    let path = sub_dir(dir, folder)?;
    let (_, stamp) = stat_folder(&path);
    let mut total = 0u64;
    let mut read = |name: &str| -> Result<Option<String>, String> {
        let file = path.join(name);
        match fs::read(&file) {
            Ok(data) => {
                total += data.len() as u64;
                if total > MAX_TOTAL {
                    return Err(format!(
                        "{folder}: ファイルが大きすぎます（合計 5 MB まで）"
                    ));
                }
                String::from_utf8(data)
                    .map(Some)
                    .map_err(|_| format!("{folder}/{name}: UTF-8 のテキストではありません"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{folder}/{name} を読めません: {e}")),
        }
    };
    let manifest = read("manifest.json")?;
    let main = read("main.js")?;
    let styles = read("styles.css")?;
    let theme = read("theme.css")?;
    let icon = read("icon.svg")?;
    Ok(DevPluginFiles {
        folder: folder.to_owned(),
        manifest,
        main,
        styles,
        theme,
        icon,
        stamp,
    })
}

/// manifest から読んだ、一覧・配布の確認に使う項目（細かい検査はサーバーが行う）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ManifestInfo {
    pub id: String,
    pub version: String,
    pub name: String,
    /// `plugin` か `theme`（省略時は `plugin`）
    #[serde(rename = "type")]
    pub kind: String,
}

/// `manifest.json` の本文から id / version / name / type を取り出す。
pub fn parse_manifest(text: &[u8]) -> Result<ManifestInfo, String> {
    let value: Value =
        serde_json::from_slice(text).map_err(|e| format!("manifest.json を読めません: {e}"))?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let need = |key: &str| {
        text(key)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("manifest.json に `{key}` がありません"))
    };
    Ok(ManifestInfo {
        id: need("id")?,
        version: need("version")?,
        name: need("name")?,
        kind: text("type").unwrap_or_else(|| "plugin".into()),
    })
}

/// 開発用フォルダ内の1つ分（フォルダ名と、読めた manifest か読めなかった理由）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevEntry {
    pub folder: String,
    pub manifest: Result<ManifestInfo, String>,
}

/// 開発用フォルダの全プラグインを、manifest つきで並べる。
pub fn list(dir: &str) -> Result<Vec<DevEntry>, String> {
    Ok(scan(dir)?
        .into_iter()
        .map(|stat| {
            let path = Path::new(dir).join(&stat.folder);
            let manifest = fs::read(path.join("manifest.json"))
                .map_err(|e| format!("{}/manifest.json を読めません: {e}", stat.folder))
                .and_then(|bytes| parse_manifest(&bytes));
            DevEntry {
                folder: stat.folder,
                manifest,
            }
        })
        .collect())
}

/// manifest の id で、開発用フォルダ内のサブフォルダを引く。見つからない・重複は理由を返す。
pub fn find_by_id(dir: &str, id: &str) -> Result<PathBuf, String> {
    let hits: Vec<DevEntry> = list(dir)?
        .into_iter()
        .filter(|e| e.manifest.as_ref().is_ok_and(|m| m.id == id))
        .collect();
    match hits.as_slice() {
        [one] => Ok(Path::new(dir).join(&one.folder)),
        [] => Err(format!(
            "開発用フォルダに id `{id}` のプラグインがありません（{dir}）"
        )),
        many => Err(format!(
            "id `{id}` が複数のフォルダにあります: {}",
            many.iter()
                .map(|e| e.folder.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(root: &Path, folder: &str, manifest: &str) {
        let d = root.join(folder);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("manifest.json"), manifest).unwrap();
        fs::write(d.join("main.js"), "1").unwrap();
    }

    #[test]
    fn finds_plugins_by_manifest_id_not_folder_name() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_str().unwrap();
        make(
            root.path(),
            "dir-a",
            r#"{"id":"dice","version":"1","name":"Dice"}"#,
        );
        make(
            root.path(),
            "dir-b",
            r#"{"id":"other","version":"2","name":"O"}"#,
        );
        make(root.path(), "dir-c", "{");
        fs::create_dir_all(root.path().join(".git")).unwrap();
        assert!(find_by_id(dir, "dice").unwrap().ends_with("dir-a"));
        assert!(find_by_id(dir, "nope").is_err());
        make(
            root.path(),
            "dir-d",
            r#"{"id":"dice","version":"3","name":"D"}"#,
        );
        assert!(find_by_id(dir, "dice").unwrap_err().contains("複数"));
        let all = list(dir).unwrap();
        assert_eq!(all.len(), 4);
        assert!(all.iter().any(|e| e.manifest.is_err()));
    }
}
