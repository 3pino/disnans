//! Android 用の自前アップデーター。公式の updater プラグインは Android に対応していないため。
//! コマンドは Rust 側で処理せず、そのまま Kotlin のプラグインに渡る。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("dev.disnans.apkupdater", "ApkUpdaterPlugin")?;
            Ok(())
        })
        .build()
}
