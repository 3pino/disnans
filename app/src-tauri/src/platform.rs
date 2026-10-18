//! 端末の事実（OS の種類など）と、その端末での方針（capabilities）を WebView に渡す（ステップ7）。
//!
//! 値は `window.__DISNANS_PLATFORM__` に、ページの読込より前に同期で入る（`js_init_script`）。
//! TS の `capabilities()`（app/src/lib/platform.ts）がこれを読む。判定は cfg! で決まり、UA 文字列は使わない。
//! 値が無い・壊れている項目は TS が従来どおり推測する（UA 側。安全側）。
//!
//! 方針（capabilities）の表は disnans-client-core（`platform.rs`）が 1 か所で持つ（ステップ8・V1）。
//! ここは、Tauri の端末の事実（cfg）を集めて渡すだけ。

use disnans_client_core::{PlatformInfo, Surface, host_os};

/// 今のビルドの端末の事実と方針（Tauri の環境）
pub fn info() -> PlatformInfo {
    disnans_client_core::info_for(
        Surface::Tauri,
        host_os(),
        cfg!(desktop),
        cfg!(target_os = "android"),
    )
}

/// main frame の読込より前に入れる一行。値が直列化できないときは null（TS は従来どおり推測する）
pub fn init_script(info: &PlatformInfo) -> String {
    let json = serde_json::to_string(info).unwrap_or_else(|_| "null".to_owned());
    format!("window.__DISNANS_PLATFORM__ = {json};")
}

/// `window.__DISNANS_PLATFORM__` を入れるプラグイン（コマンドは持たない。権限も要らない）
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("disnans-platform")
        .js_init_script(init_script(&info()))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_name_matches_the_build_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(info().os, "windows");
        #[cfg(target_os = "linux")]
        assert_eq!(info().os, "linux");
        #[cfg(target_os = "macos")]
        assert_eq!(info().os, "macos");
        #[cfg(target_os = "android")]
        assert_eq!(info().os, "android");
    }

    #[test]
    fn desktop_and_android_are_exclusive() {
        let i = info();
        assert!(!(i.desktop && i.android), "{i:?}");
        if i.android {
            assert_eq!(i.os, "android");
        }
        assert_eq!(i.surface, Surface::Tauri);
    }

    /// この OS のビルドでは、実際の判定が core の表と一致する（CI の windows・linux・macos・android で走る）
    #[test]
    fn this_build_reports_the_matching_row() {
        let i = info();
        assert_eq!(
            i.capabilities,
            disnans_client_core::capabilities_for(Surface::Tauri, i.os, i.desktop, i.android)
        );
    }

    #[test]
    fn init_script_assigns_the_global_once() {
        let script = init_script(&disnans_client_core::info_for(
            Surface::Tauri,
            "linux",
            true,
            false,
        ));
        assert!(
            script.starts_with("window.__DISNANS_PLATFORM__ = {"),
            "{script}"
        );
        assert!(script.ends_with("};"), "{script}");
        assert!(script.contains(r#""os":"linux""#), "{script}");
        assert!(script.contains(r#""surface":"tauri""#), "{script}");
        assert!(script.contains(r#""rustChat":"default""#), "{script}");
        assert!(script.contains(r#""nativeScreen":"linux""#), "{script}");
    }
}
