//! 開発用フォルダのプラグイン・テーマ（PC 版だけ）。走査と読み込みは client-core の `dev_plugins`（CLI と共通）。
//!
//! フロントエンドは1秒ごとに `dev_plugins_scan` で更新時刻を見て、変わったものだけ `dev_plugin_read` で読み直す。

use disnans_client_core::dev_plugins::{self, DevPluginFiles, DevPluginStat};

/// 開発用フォルダの中のサブフォルダを並べる。`manifest.json` か `main.js` があるものだけ
#[tauri::command]
pub fn dev_plugins_scan(dir: String) -> Result<Vec<DevPluginStat>, String> {
    dev_plugins::scan(&dir)
}

/// サブフォルダ1つのファイルを読む
#[tauri::command]
pub fn dev_plugin_read(dir: String, folder: String) -> Result<DevPluginFiles, String> {
    dev_plugins::read_folder(&dir, &folder)
}
