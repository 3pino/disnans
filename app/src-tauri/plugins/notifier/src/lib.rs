//! Android の通知。フォアグラウンドサービスが WebView とは別にサーバーの WebSocket につなぎ、
//! `notify` を受け取ったらシステム通知を出す（SPEC 4.3。FCM などには依存しない）。
//! コマンドは Rust 側で処理せず、そのまま Kotlin のプラグインに渡る。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notifier")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("dev.disnans.notifier", "NotifierPlugin")?;
            Ok(())
        })
        .build()
}
