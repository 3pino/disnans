/// 開発者ツールを開く（フロントエンドの Ctrl+Shift+I から呼ぶ。配布版でも使える）
#[cfg(desktop)]
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// デバイスの事実（OS の種類）を WebView に渡す。window.__DISNANS_PLATFORM__（ステップ7）
mod platform;

#[cfg(desktop)]
mod dev_plugins;

// 添付パネルの「最近の画像」（ピクチャのフォルダ）
#[cfg(desktop)]
mod recent_images;

// Desktop shared server settings and drafts; browser/Android keep their existing storage.
// 共有の設定と下書き（デスクトップは既定の場所、Android はアプリのデータの中）
#[cfg(any(desktop, target_os = "android"))]
mod client_storage;

#[cfg(all(test, desktop))]
mod client_storage_tests;

// 読取・書込み・アップロード REST の Rust 経路（段1・段3）。契約は .pi/step4-ipc-contract.md。
// REST（読取・書込み・アップロード）の Rust 経路（段1・段3）。Android も同じ
#[cfg(any(desktop, target_os = "android"))]
mod api_bridge;

// チャット WebSocket の Rust 経路（段4）。契約は .pi/step4-ipc-contract.md §8。
// デスクトップは ws 依存と同じ OS だけ。Android も使う（段4）
#[cfg(any(all(desktop, any(windows, target_os = "linux")), target_os = "android"))]
mod chat_bridge;

// 画面の静止画（プラグイン API v11 の screenCapture.snapshot。ダイアログを出さない）
#[cfg(desktop)]
mod snapshot;

// デスクトップの通知（Windows・Linux は押したらウィンドウを前面に出す）
#[cfg(desktop)]
mod desktop_notify;

// Linux の画面共有: portal / PipeWire。静止画のプレビューとは別の取得経路
#[cfg(target_os = "linux")]
mod linux_capture;

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

/// Android の証明書: rustls-native-certs は openssl-probe の既定の場所（/etc/ssl）しか見ないので、
/// Android では空になる（webpki は残るので接続は通るが、デバイスの CA は使えない）。
/// Android のシステム CA は OpenSSL と同じ形（<hash>.0 の PEM）の dir なので、SSL_CERT_DIR で指す。
/// 利用者が入れた CA（/data の cacerts-added）は含まれない。
///
/// 環境変数の書き換えは unsafe（他のスレッドが getenv すると競合する）。だから run() の最初に、
/// アプリのスレッドを作る前に呼ぶ。既に指定されていれば何もしない。
#[cfg(target_os = "android")]
fn use_android_system_certs() {
    const SYSTEM_CA_DIR: &str = "/system/etc/security/cacerts";
    if std::env::var_os("SSL_CERT_DIR").is_some() || !std::path::Path::new(SYSTEM_CA_DIR).is_dir() {
        return;
    }
    // SAFETY: run() の先頭で、このプロセスがまだ自前のスレッドを作っていない時点で呼ぶ（上のコメント）
    unsafe { std::env::set_var("SSL_CERT_DIR", SYSTEM_CA_DIR) };
}

/// Linux: WebKitGTK のマイク取り込み（PipeWire）は、既定のバッファだと通話の音が数秒遅れ、
/// しだいに増えることがある（PIPEWIRE_LATENCY=256/48000 で直ることを実機で確認）。
/// 利用者が指定していれば、それを優先する。環境変数の書き換えは unsafe なので、run() の最初に呼ぶ。
#[cfg(target_os = "linux")]
fn set_linux_audio_latency() {
    if std::env::var_os("PIPEWIRE_LATENCY").is_some() {
        return;
    }
    // SAFETY: run() の先頭で、このプロセスがまだ自前のスレッドを作っていない時点で呼ぶ
    unsafe { std::env::set_var("PIPEWIRE_LATENCY", "256/48000") };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    use_android_system_certs();
    #[cfg(target_os = "linux")]
    set_linux_audio_latency();

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

    #[cfg(any(all(desktop, any(windows, target_os = "linux")), target_os = "android"))]
    {
        builder = builder.manage(chat_bridge::ChatHub::default());
    }

    builder = builder.plugin(platform::plugin());
    builder = builder.plugin(tauri_plugin_opener::init());

    // アップデート: デスクトップは公式の updater、Android は自前のプラグイン
    // 通知: デスクトップは公式の notification、Android は常駐サービスを持つ自前のプラグイン
    // dialog: 開発用フォルダを選ぶ（デスクトップだけ）
    // fs / clipboard-manager: Linux でのファイルのドロップ（capabilities/linux.json）、クリップボードの画像とピクチャのフォルダの読み込み（capabilities/desktop.json）
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_clipboard_manager::init());
        #[cfg(not(target_os = "linux"))]
        {
            builder = builder.invoke_handler(tauri::generate_handler![
                open_devtools,
                desktop_notify::desktop_notify,
                recent_images::recent_images,
                dev_plugins::dev_plugins_scan,
                dev_plugins::dev_plugin_read,
                snapshot::screen_snapshot,
                client_storage::client_storage_read,
                client_storage::client_device_id,
                client_storage::client_storage_write,
                client_storage::client_storage_import,
                api_bridge::api_me,
                api_bridge::api_users,
                api_bridge::api_prefs,
                api_bridge::api_messages,
                api_bridge::api_search_messages,
                api_bridge::api_read_markers,
                api_bridge::api_plugins,
                api_bridge::api_session,
                api_bridge::api_update_me,
                api_bridge::api_clear_avatar,
                api_bridge::api_set_avatar,
                api_bridge::api_set_prefs,
                api_bridge::api_device_register,
                api_bridge::api_settings_definitions,
                api_bridge::api_markdown_tree,
                api_bridge::api_device_prefs_read,
                api_bridge::api_device_prefs_write,
                api_bridge::api_devices_list,
                api_bridge::api_device_delete,
                api_bridge::api_mark_read,
                api_bridge::api_update_session,
                api_bridge::api_delete_plugin,
                api_bridge::api_sample_notification,
                api_bridge::api_plugin_post_message,
                api_bridge::api_plugin_notify,
                api_bridge::api_create_session,
                api_bridge::api_create_plugin,
                api_bridge::api_upload_file,
                api_bridge::api_upload_abort,
                chat_bridge::chat_start,
                chat_bridge::chat_send,
                chat_bridge::chat_emit,
                chat_bridge::chat_reconnect,
                chat_bridge::chat_stop
            ]);
        }
        #[cfg(target_os = "linux")]
        {
            builder = builder
                .manage(linux_capture::LinuxScreenState::default())
                .invoke_handler(tauri::generate_handler![
                    open_devtools,
                    desktop_notify::desktop_notify,
                    recent_images::recent_images,
                    dev_plugins::dev_plugins_scan,
                    dev_plugins::dev_plugin_read,
                    snapshot::screen_snapshot,
                    linux_capture::linux_screen_start,
                    linux_capture::linux_screen_stop,
                    linux_capture::linux_screen_update,
                    client_storage::client_storage_read,
                    client_storage::client_device_id,
                    client_storage::client_storage_write,
                    client_storage::client_storage_import,
                    api_bridge::api_me,
                    api_bridge::api_users,
                    api_bridge::api_prefs,
                    api_bridge::api_messages,
                    api_bridge::api_search_messages,
                    api_bridge::api_read_markers,
                    api_bridge::api_plugins,
                    api_bridge::api_session,
                    api_bridge::api_update_me,
                    api_bridge::api_clear_avatar,
                    api_bridge::api_set_avatar,
                    api_bridge::api_set_prefs,
                    api_bridge::api_device_register,
                    api_bridge::api_settings_definitions,
                    api_bridge::api_markdown_tree,
                    api_bridge::api_device_prefs_read,
                    api_bridge::api_device_prefs_write,
                    api_bridge::api_devices_list,
                    api_bridge::api_device_delete,
                    api_bridge::api_mark_read,
                    api_bridge::api_update_session,
                    api_bridge::api_delete_plugin,
                    api_bridge::api_sample_notification,
                    api_bridge::api_plugin_post_message,
                    api_bridge::api_plugin_notify,
                    api_bridge::api_create_session,
                    api_bridge::api_create_plugin,
                    api_bridge::api_upload_file,
                    api_bridge::api_upload_abort,
                    chat_bridge::chat_start,
                    chat_bridge::chat_send,
                    chat_bridge::chat_emit,
                    chat_bridge::chat_reconnect,
                    chat_bridge::chat_stop
                ]);
        }
    }
    // Android: システムバーのアイコンの明暗をアプリのテーマに合わせる
    #[cfg(target_os = "android")]
    {
        builder = builder
            .invoke_handler(tauri::generate_handler![
                read_shared_file,
                api_bridge::api_me,
                api_bridge::api_users,
                api_bridge::api_prefs,
                api_bridge::api_messages,
                api_bridge::api_search_messages,
                api_bridge::api_read_markers,
                api_bridge::api_plugins,
                api_bridge::api_session,
                api_bridge::api_update_me,
                api_bridge::api_clear_avatar,
                api_bridge::api_set_avatar,
                api_bridge::api_set_prefs,
                api_bridge::api_device_register,
                api_bridge::api_settings_definitions,
                api_bridge::api_markdown_tree,
                api_bridge::api_device_prefs_read,
                api_bridge::api_device_prefs_write,
                api_bridge::api_devices_list,
                api_bridge::api_device_delete,
                api_bridge::api_mark_read,
                api_bridge::api_update_session,
                api_bridge::api_delete_plugin,
                api_bridge::api_sample_notification,
                api_bridge::api_plugin_post_message,
                api_bridge::api_plugin_notify,
                api_bridge::api_create_session,
                api_bridge::api_create_plugin,
                api_bridge::api_upload_file,
                api_bridge::api_upload_abort,
                chat_bridge::chat_start,
                chat_bridge::chat_send,
                chat_bridge::chat_emit,
                chat_bridge::chat_reconnect,
                chat_bridge::chat_stop,
                client_storage::client_storage_read,
                client_storage::client_device_id,
                client_storage::client_storage_write,
                client_storage::client_storage_import
            ])
            .setup(|app| {
                use tauri::Manager;
                // 共有の設定と下書きは、アプリのデータの中に置く（Android には HOME が無い）
                client_storage::use_app_data_root(app.path().app_data_dir()?);
                Ok(())
            })
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

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|_app, _event| {
        #[cfg(target_os = "linux")]
        if matches!(_event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            // async runtime と portal の接続が生きている間に、画面共有の資源を外す
            _app.state::<linux_capture::LinuxScreenState>().shutdown();
        }
        // チャット接続を中止する。待たない（準備中の接続も止める）。保留中の送信は unknown になり、再送はしない
        #[cfg(any(all(desktop, any(windows, target_os = "linux")), target_os = "android"))]
        if matches!(_event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            _app.state::<chat_bridge::ChatHub>().shutdown_now();
        }
    });
}
