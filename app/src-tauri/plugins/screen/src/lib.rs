//! Android の画面まわりのネイティブ機能。
//! - 画面のキャプチャ（MediaProjection）: 縮小した JPEG / WebP / PNG のフレームを JS にイベントで渡す（`disnans.screenCapture`）
//! - ピクチャーインピクチャー（Activity の小窓）（`disnans.pip`）
//! コマンドは Rust 側で処理せず、そのまま Kotlin のプラグインに渡る。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screen")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("dev.disnans.screen", "ScreenPlugin")?;
            Ok(())
        })
        .build()
}
