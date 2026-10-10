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

/// WebKitGTK で getUserMedia / WebRTC を使えるようにする（通話用）。
/// 動くには、システムに GStreamer のプラグイン（gst-plugins-good / -bad、libnice の gstreamer プラグイン）が要る。
#[cfg(target_os = "linux")]
fn enable_webrtc(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        let wv = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wv) {
            let was_on = settings.enables_media_stream();
            settings.set_enable_media_stream(true);
            settings.set_enable_webrtc(true);
            settings.set_enable_mediasource(true);
            // navigator.mediaDevices は JS のグローバルを作るときに設定を見て決まる。
            // setup はページの読み込みが始まったあとに走りうるので、設定を変えたときは読み込み直して確実に反映する
            if !was_on {
                WebViewExt::reload(&wv);
            }
        }
    });
}

/// メインウィンドウを出して前面に持ってくる（トレイから）
#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// システムトレイ（通知領域）のアイコン。左クリックでウィンドウを出し、右クリックのメニューに「開く」「終了」。
/// ウィンドウを閉じても隠すだけなので、アプリを終えるのはここの「終了」だけ。
/// Linux（libayatana-appindicator）はアイコンのクリックを受け取れず、クリックでメニューが開く
#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItemBuilder::with_id("tray-open", "開く").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "終了").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("disnans")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // 単一インスタンス（デスクトップ）: 2つ目の起動は新しく立ち上げず、既存のウィンドウを出して前面に持ってくる。
    // ほかのプラグインより先に登録する（先に登録しないと、2つ目のプロセスが立ち上がってしまうため）
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder = builder.plugin(tauri_plugin_opener::init());

    // アップデート: デスクトップは公式の updater、Android は自前のプラグイン
    // 通知: デスクトップは公式の notification、Android は常駐サービスを持つ自前のプラグイン
    // dialog: 開発用フォルダを選ぶ（デスクトップだけ）
    // fs / clipboard-manager: Linux でのファイルのドロップと、クリップボードの画像の貼り付け（capabilities/linux.json で許可）
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_clipboard_manager::init())
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
            .plugin(tauri_plugin_screen::init())
            .plugin(tauri_plugin_notifier::init());
    }

    // 通話（getUserMedia / getDisplayMedia）: マイクと画面の取得を許可する。カメラなどは既定のまま
    // （画面の取得は、どの画面を共有するかを OS / WebView の選択画面で利用者が選ぶので、アプリ側の確認は省く）
    // （Windows は WebView2 の確認を省き、Linux は WebKitGTK の許可の要求に答え、Android は OS の許可へ進める）
    builder = builder.on_permission_request(|_webview, kind| match kind {
        tauri::webview::PermissionKind::Microphone | tauri::webview::PermissionKind::DisplayCapture => {
            tauri::webview::PermissionResponse::Allow
        }
        _ => tauri::webview::PermissionResponse::Default,
    });

    // デスクトップ: ウィンドウを閉じても隠すだけにして、バックグラウンドで動き続ける（WebSocket と通知の受信）。
    // 終了はトレイのメニューから。トレイのアイコンも setup で作る
    #[cfg(desktop)]
    {
        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
        builder = builder.setup(|app| {
            setup_tray(app)?;
            // Linux の WebKitGTK は、WebRTC とメディアストリーム（getUserMedia）が既定でオフ
            #[cfg(target_os = "linux")]
            enable_webrtc(app);
            Ok(())
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
