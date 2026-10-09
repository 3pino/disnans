/// 開発者ツールを開く（フロントエンドの Ctrl+Shift+I から呼ぶ。配布版でも使える）
#[cfg(desktop)]
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[cfg(desktop)]
mod dev_plugins;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // アップデート: デスクトップは公式の updater、Android は自前のプラグイン
    // 通知: デスクトップは公式の notification、Android は常駐サービスを持つ自前のプラグイン
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            .invoke_handler(tauri::generate_handler![
                open_devtools,
                dev_plugins::dev_plugins_scan,
                dev_plugins::dev_plugin_read
            ]);
    }
    // Android: システムバーのアイコンの明暗をアプリのテーマに合わせる
    #[cfg(target_os = "android")]
    {
        builder = builder
            .plugin(tauri_plugin_apk_updater::init())
            .plugin(tauri_plugin_system_bars::init())
            .plugin(tauri_plugin_notifier::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
