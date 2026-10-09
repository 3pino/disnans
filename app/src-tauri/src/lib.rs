#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // アップデート: デスクトップは公式の updater、Android は自前のプラグイン
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_apk_updater::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
