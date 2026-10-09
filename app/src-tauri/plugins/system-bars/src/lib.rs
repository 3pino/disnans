//! Android のステータスバー・ナビゲーションバーのアイコンの明暗を、アプリのテーマに合わせる。
//! 何もしないとシステムのテーマに従うため、アプリだけライトにすると白いアイコンが見えなくなる。
//! コマンドは Rust 側で処理せず、そのまま Kotlin のプラグインに渡る。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-bars")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("dev.disnans.systembars", "SystemBarsPlugin")?;
            Ok(())
        })
        .build()
}
