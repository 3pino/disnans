//! 端末の事実（OS の種類など）と、その端末での方針（capabilities）を WebView に渡す（ステップ7）。
//!
//! 値は `window.__DISNANS_PLATFORM__` に、ページの読込より前に同期で入る（`js_init_script`）。
//! TS の `capabilities()`（app/src/lib/platform.ts）がこれを読む。判定は cfg! で決まり、UA 文字列は使わない。
//! 値が無い・壊れている項目は TS が従来どおり推測する（UA 側。安全側）。
//!
//! 方針（capabilities）は `capabilities_for` の 1 か所で決める。TS の推測（platform.ts の inferred）と同じ表になる。

use serde::Serialize;

/// 端末の事実と方針。JSON の形は TS の InjectedPlatform と揃える（camelCase）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "windows" | "linux" | "macos" | "android" | "ios" | "other"
    pub os: &'static str,
    /// デスクトップの Tauri か（windows・linux・macos）
    pub desktop: bool,
    /// Android の Tauri か
    pub android: bool,
    /// この端末での方針（TS の Capabilities と揃える）
    pub capabilities: Capabilities,
}

/// 端末の方針。値は TS の Capabilities と同じ名前・同じ文字列
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// 共有ファイルの設定（client_storage）を使う（Windows・Linux の Tauri）
    pub shared_storage: bool,
    /// 読取・書込・添付を Rust 経路で行う（既定で on。flag "0" で off）
    pub rust_api: bool,
    /// チャットの経路: "default"（既定で Rust。localStorage "disnans.rustChat"="0" で JS に戻る）・"off"（JS のまま）
    pub rust_chat: &'static str,
    /// 本体の渡し方: "raw"（バイト列）・"base64"（Android の WebView）
    pub body_mode: &'static str,
    /// 通知の出し方: "android"（常駐サービス）・"desktop"（公式の通知）
    pub notify_backend: &'static str,
    /// アップデートの経路: "desktop"・"android"・None（対象外）
    pub updater: Option<&'static str>,
    /// 通話の音声出力の切り替えを Kotlin（AudioManager）で行う（Android）
    pub native_audio_output: bool,
    /// 画面を切っても動く常駐（Android の前景サービス）
    pub background_service: bool,
    /// 画面共有の経路: "android"（MediaProjection）・"linux"（PipeWire）・None
    pub native_screen: Option<&'static str>,
    /// 開発用フォルダ（プラグインとテーマ）を使える（Android 以外の Tauri）
    pub dev_folder: bool,
}

/// 今のビルドの端末の事実と方針
pub fn info() -> PlatformInfo {
    let os = os_name();
    let desktop = cfg!(desktop);
    let android = cfg!(target_os = "android");
    PlatformInfo {
        os,
        desktop,
        android,
        capabilities: capabilities_for(os, desktop, android),
    }
}

/// 端末の事実から方針を決める（この 1 か所だけ）。
/// 従来の TS の判定（desktop = Windows/Linux の Tauri、android = Tauri の Android）と同じ結果になるように書いてある。
pub fn capabilities_for(os: &str, desktop: bool, android: bool) -> Capabilities {
    let shared_storage = desktop && matches!(os, "windows" | "linux");
    Capabilities {
        shared_storage,
        rust_api: shared_storage || android,
        // Android は既定で Rust（S1）。JS Socket と同じ uid で動くので、背景の条件は同じ
        rust_chat: if shared_storage || android {
            "default"
        } else {
            "off"
        },
        body_mode: if android { "base64" } else { "raw" },
        notify_backend: if android { "android" } else { "desktop" },
        updater: Some(if android { "android" } else { "desktop" }),
        native_audio_output: android,
        background_service: android,
        native_screen: if android {
            Some("android")
        } else if os == "linux" {
            Some("linux")
        } else {
            None
        },
        dev_folder: !android,
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
    }

    fn keys_of(value: &serde_json::Value) -> Vec<&str> {
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys
    }

    #[test]
    fn json_has_exactly_the_camel_case_keys() {
        let value = serde_json::to_value(info()).unwrap();
        assert_eq!(
            keys_of(&value),
            ["android", "capabilities", "desktop", "os"]
        );
        assert_eq!(
            keys_of(&value["capabilities"]),
            [
                "backgroundService",
                "bodyMode",
                "devFolder",
                "nativeAudioOutput",
                "nativeScreen",
                "notifyBackend",
                "rustApi",
                "rustChat",
                "sharedStorage",
                "updater",
            ]
        );
    }

    /// 端末ごとの方針の表（TS の P0 の表と同じ）。この 4 つの組み合わせは、どの OS のビルドでも確かめられる
    #[test]
    fn capabilities_table_matches_the_policy() {
        let win = capabilities_for("windows", true, false);
        assert!(win.shared_storage && win.rust_api && win.dev_folder);
        assert_eq!(
            (win.rust_chat, win.body_mode, win.native_screen),
            ("default", "raw", None)
        );
        assert_eq!(win.updater, Some("desktop"));

        let linux = capabilities_for("linux", true, false);
        assert!(linux.shared_storage && linux.rust_api);
        assert_eq!(linux.native_screen, Some("linux"));
        assert_eq!(linux.rust_chat, "default");

        let mac = capabilities_for("macos", true, false);
        assert!(!mac.shared_storage && !mac.rust_api);
        assert_eq!(mac.rust_chat, "off");
        assert!(mac.dev_folder);
        assert_eq!(mac.native_screen, None);

        let android = capabilities_for("android", false, true);
        assert!(android.rust_api && !android.shared_storage && !android.dev_folder);
        assert_eq!(
            (android.rust_chat, android.body_mode),
            ("default", "base64")
        );
        assert_eq!(android.updater, Some("android"));
        assert_eq!(android.native_screen, Some("android"));
        assert!(android.native_audio_output && android.background_service);
    }

    /// この OS のビルドでは、実際の判定が表と一致する（CI の windows・linux・macos・android で走る）
    #[test]
    fn this_build_reports_the_matching_row() {
        #[cfg(target_os = "windows")]
        assert_eq!(
            info().capabilities,
            capabilities_for("windows", true, false)
        );
        #[cfg(target_os = "linux")]
        assert_eq!(info().capabilities, capabilities_for("linux", true, false));
        #[cfg(target_os = "macos")]
        assert_eq!(info().capabilities, capabilities_for("macos", true, false));
        #[cfg(target_os = "android")]
        assert_eq!(
            info().capabilities,
            capabilities_for("android", false, true)
        );
    }

    #[test]
    fn init_script_assigns_the_global_once() {
        let script = init_script(&PlatformInfo {
            os: "linux",
            desktop: true,
            android: false,
            capabilities: capabilities_for("linux", true, false),
        });
        assert!(
            script.starts_with("window.__DISNANS_PLATFORM__ = {"),
            "{script}"
        );
        assert!(script.ends_with("};"), "{script}");
        assert!(script.contains(r#""os":"linux""#), "{script}");
        assert!(script.contains(r#""rustChat":"default""#), "{script}");
        assert!(script.contains(r#""nativeScreen":"linux""#), "{script}");
    }
}
