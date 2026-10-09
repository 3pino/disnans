//! 開発用フォルダのプラグイン（PC 版だけ）。
//!
//! 開発用フォルダの中の、サブフォルダ1つが1つのプラグイン。
//! フロントエンドは1秒ごとに `dev_plugins_scan` で更新時刻を見て、変わったものだけ `dev_plugin_read` で読み直す。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// 読むファイル（配布できるのもこれだけ）
const FILES: [&str; 4] = ["manifest.json", "main.js", "styles.css", "icon.svg"];

/// 1つのプラグインの合計の上限（サーバーの配布の上限と同じ 5 MB）
const MAX_TOTAL: u64 = 5 * 1024 * 1024;

/// フォルダ1つ分の様子（中身は含まない）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPluginStat {
    /// サブフォルダの名前
    folder: String,
    /// FILES のうち、あるもの
    files: Vec<String>,
    /// ファイルの更新時刻（ミリ秒）と大きさから作った値。変わったら読み直す
    stamp: String,
}

/// フォルダ1つ分の中身
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPluginFiles {
    folder: String,
    manifest: Option<String>,
    main: Option<String>,
    styles: Option<String>,
    /// プラグインのアイコン（任意。24x24 の SVG）
    icon: Option<String>,
    stamp: String,
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
#[tauri::command]
pub fn dev_plugins_scan(dir: String) -> Result<Vec<DevPluginStat>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| format!("フォルダを開けません（{dir}）: {e}"))?;
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
        out.push(DevPluginStat { folder, files, stamp });
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}

/// サブフォルダ1つのファイル（FILES）を読む
#[tauri::command]
pub fn dev_plugin_read(dir: String, folder: String) -> Result<DevPluginFiles, String> {
    let path = sub_dir(&dir, &folder)?;
    let (_, stamp) = stat_folder(&path);
    let mut total = 0u64;
    let mut read = |name: &str| -> Result<Option<String>, String> {
        let file = path.join(name);
        match fs::read(&file) {
            Ok(data) => {
                total += data.len() as u64;
                if total > MAX_TOTAL {
                    return Err(format!("{folder}: ファイルが大きすぎます（合計 5 MB まで）"));
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
    let icon = read("icon.svg")?;
    Ok(DevPluginFiles {
        folder,
        manifest,
        main,
        styles,
        icon,
        stamp,
    })
}
