//! Android 用の自前アップデーター。公式の updater プラグインは Android に対応していないため。
//! コマンドは Rust 側で処理せず、そのまま Kotlin のプラグインに渡る。
//! 添付・共有フォルダのファイルの保存（MediaStore の Downloads）と開く操作も、Kotlin のこのプラグインが持つ。
//! 呼び出しは Rust（app の downloads.rs）から、下の受け口を通して行うので、WebView 側の権限は増えない。

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Kotlin のプラグインへの受け口（Android だけ）。JSON の形は呼び出し側（app）が決める
#[cfg(target_os = "android")]
pub struct MediaHandle<R: Runtime>(pub PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-updater")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    _api.register_android_plugin("dev.disnans.apkupdater", "ApkUpdaterPlugin")?;
                _app.manage(MediaHandle(handle));
            }
            Ok(())
        })
        .build()
}
