/// 開発者ツールを開く（フロントエンドの Ctrl+Shift+I から呼ぶ。配布版でも使える）
#[cfg(desktop)]
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[cfg(desktop)]
mod dev_plugins;

/// 他のアプリから共有されたファイルを読む（Android）。
/// notifier プラグインがキャッシュの `disnans-share/` にコピーしたものだけを読み、読んだら消す。
/// 大きなファイルを base64 の JSON にせず、バイナリのまま WebView に渡すためのコマンド。
#[cfg(target_os = "android")]
#[tauri::command]
fn read_shared_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = std::fs::canonicalize(&path).map_err(|e| format!("共有されたファイルを開けません: {e}"))?;
    if !p.ancestors().skip(1).any(|a| a.file_name().is_some_and(|n| n == "disnans-share")) {
        return Err("共有されたファイルではありません".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("共有されたファイルを読めません: {e}"))?;
    let _ = std::fs::remove_file(&p);
    if let Some(dir) = p.parent() {
        // 共有1回分のフォルダが空になったら消す
        let _ = std::fs::remove_dir(dir);
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// WebKitGTK で getUserMedia / WebRTC を使えるようにする（通話プラグイン用）。
/// 動くには、システムに GStreamer のプラグイン（gst-plugins-good / -bad、libnice の gstreamer プラグイン）が要る。
#[cfg(target_os = "linux")]
fn enable_webrtc(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        if let Some(settings) = WebViewExt::settings(&webview.inner()) {
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
            settings.set_enable_mediasource(true);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // アップデート: デスクトップは公式の updater、Android は自前のプラグイン
    // 通知: デスクトップは公式の notification、Android は常駐サービスを持つ自前のプラグイン
    // dialog: 開発用フォルダを選ぶ（デスクトップだけ）
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init())
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
            .invoke_handler(tauri::generate_handler![read_shared_file])
            .plugin(tauri_plugin_apk_updater::init())
            .plugin(tauri_plugin_system_bars::init())
            .plugin(tauri_plugin_notifier::init());
    }

    // 通話（プラグインの getUserMedia / WebRTC）: マイクだけ許可する。カメラ・画面共有などは既定のまま
    // （Windows は WebView2 の確認を省き、Linux は WebKitGTK の許可の要求に答え、Android は OS の許可へ進める）
    builder = builder.on_permission_request(|_webview, kind| match kind {
        tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
        _ => tauri::webview::PermissionResponse::Default,
    });

    // Linux の WebKitGTK は、WebRTC とメディアストリーム（getUserMedia）が既定でオフ
    #[cfg(target_os = "linux")]
    {
        builder = builder.setup(|app| {
            enable_webrtc(app);
            Ok(())
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
