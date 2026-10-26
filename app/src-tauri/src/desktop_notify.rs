//! デスクトップの通知（Windows・Linux）。プラグインの通知はクリックを受け取れないので、ここで出す。
//! 通知を押すとメインウィンドウを前面に出し、フロントに知らせる（アプリが動いているときだけ。終了していれば何も起きない）。
//! Android の通知は notifier（Kotlin）が出す。

use std::path::Path;

use tauri::AppHandle;
// config() と get_webview_window() は Manager、emit は Emitter のメソッド
#[cfg(any(windows, target_os = "linux"))]
use tauri::{Emitter, Manager};

/// 通知を押したあと、フロントに送るイベント名（src/lib/systemNotify.ts と同じ値）。
/// フロントは、Android の notifier の open と同じ動作（チャットを表示する）をこれで行う
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
const CLICKED_EVENT: &str = "desktop-notification-clicked";

/// Linux で、通知の本体を押したときのアクション名（通知仕様の既定の動作）
#[cfg(target_os = "linux")]
const DEFAULT_ACTION: &str = "default";

/// JS の sendNotification の代わり。title と body をそのまま出す（タグ・まとめは付けない。従来どおり）
#[tauri::command]
pub fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    show(&app, &title, &body)
}

/// メインウィンドウを前面に出す（隠れていれば出し、最小化なら戻す）。ウィンドウが無ければ何もしない
#[cfg(any(windows, target_os = "linux"))]
fn focus_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 通知が押されたときの動作: ウィンドウを前面に出し、フロントに知らせる（チャットの表示はフロントが行う）
#[cfg(any(windows, target_os = "linux"))]
fn on_clicked(app: &AppHandle) {
    focus_main_window(app);
    let _ = app.emit(CLICKED_EVENT, ());
}

/// 実行ファイルのフォルダが cargo の出力（target/debug か target/release）か。
/// Windows の通知は、開発用のときは別の AppUserModelID を使う（プラグインと同じ決め方）
#[cfg_attr(not(windows), allow(dead_code))]
fn is_dev_exe_dir(dir: &Path) -> bool {
    // 末尾から見る: 1つ目が debug / release、2つ目が target
    let mut parts = dir
        .components()
        .rev()
        .filter_map(|c| c.as_os_str().to_str());
    matches!(
        (parts.next(), parts.next()),
        (Some("debug" | "release"), Some("target"))
    )
}

#[cfg(windows)]
fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_winrt_notification::{Duration, Toast};

    // インストール済みは製品の ID。開発用は PowerShell の ID（プラグインと同じ。製品の ID だと開発用では出ない）
    let dev = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(is_dev_exe_dir))
        .unwrap_or(true);
    let app_id = if dev {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };

    // 押されたら前面に出す（引数は使わない。本文の押下だけ）。見た目はプラグインの通知と同じ（件名 + 本文 1 行）
    let handle = app.clone();
    Toast::new(&app_id)
        .title(title)
        .text1("")
        .text2(body)
        .sound(None)
        .duration(Duration::Short)
        .on_activated(move |_| {
            on_clicked(&handle);
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    let handle = notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .auto_icon()
        .action(DEFAULT_ACTION, "開く")
        .show()
        .map_err(|e| e.to_string())?;
    // 押されるか閉じられるまで待つ。待つだけのスレッドなので、ほかの処理は止めない
    let app = app.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action == DEFAULT_ACTION {
                on_clicked(&app);
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 押したときのイベント名はフロントと同じ() {
        assert_eq!(CLICKED_EVENT, "desktop-notification-clicked");
    }

    #[test]
    fn cargo_の出力フォルダは開発用と判定する() {
        assert!(is_dev_exe_dir(Path::new(
            "C:/src/disnans/app/src-tauri/target/debug"
        )));
        assert!(is_dev_exe_dir(Path::new("/home/u/repo/target/release")));
    }

    #[test]
    fn インストール先や似た名前のフォルダは開発用ではない() {
        assert!(!is_dev_exe_dir(Path::new("C:/Program Files/disnans")));
        assert!(!is_dev_exe_dir(Path::new("/opt/disnans/debug")));
        assert!(!is_dev_exe_dir(Path::new("/home/u/target/x/debug")));
        assert!(!is_dev_exe_dir(Path::new("/home/u/target/release-notes")));
    }
}
