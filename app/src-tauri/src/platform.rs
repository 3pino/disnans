//! 端末の事実（OS の種類など）を WebView に渡す（ステップ7・P1）。
//!
//! 値は `window.__DISNANS_PLATFORM__` に、ページの読込より前に同期で入る（`js_init_script`）。
//! TS の `platform()`（app/src/lib/platform.ts）がこれを読む。判定は cfg! で決まり、UA 文字列は使わない。
//! 値が無い・壊れているときは TS が UA に戻る（安全側）。
//!
//! ここには「事実」だけを置く。Rust の API を使うか・shared storage・既定のチャットなどの**方針**は、
//! 挙動を変えないために TS 側（transport/select.ts など）に残す。

use serde::Serialize;

/// 端末の事実。JSON の形は TS の PlatformInfo と揃える（camelCase）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "windows" | "linux" | "macos" | "android" | "ios" | "other"
    pub os: &'static str,
    /// デスクトップの Tauri か（windows・linux・macos）
    pub desktop: bool,
    /// Android の Tauri か
    pub android: bool,
}

/// 今のビルドの端末の事実
pub fn info() -> PlatformInfo {
    PlatformInfo {
        os: os_name(),
        desktop: cfg!(desktop),
        android: cfg!(target_os = "android"),
    }
}

fn os_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

/// main frame の読込より前に入れる一行。値が直列化できないときは null（TS は UA に戻る）
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
    }

    #[test]
    fn json_has_exactly_the_three_camel_case_keys() {
        let value = serde_json::to_value(info()).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["android", "desktop", "os"]);
    }

    #[test]
    fn init_script_assigns_the_global_once() {
        let script = init_script(&PlatformInfo {
            os: "linux",
            desktop: true,
            android: false,
        });
        assert_eq!(
            script,
            r#"window.__DISNANS_PLATFORM__ = {"os":"linux","desktop":true,"android":false};"#
        );
    }
}
