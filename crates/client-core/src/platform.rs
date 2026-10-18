//! デバイスの事実（環境の種類・OS など）と、その環境での方針（capabilities）（ステップ8・V1）。
//!
//! 方針は `capabilities_for` の 1 か所で決める。GUI（Tauri の WebView）と、TUI・CLI（ターミナル）が同じ表を使う。
//! 環境（surface）は `tauri`・`tui`・`cli` の 3 つ。`tauri` の値は、従来の app/src-tauri/src/platform.rs の表と同じ。
//! 描画や文字の幅には依存しない（ここは判断だけを返す）。

use serde::Serialize;

/// 環境の種類。JSON では `"tauri"` | `"tui"` | `"cli"`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    /// デスクトップ・Android の Tauri（WebView の GUI）
    Tauri,
    /// `disnans tui`（ターミナルの全画面）
    Tui,
    /// 通常のコマンド（`disnans send` など）
    Cli,
}

/// デバイスの事実と方針。JSON の形は TS の InjectedPlatform と揃える（camelCase）。
/// `surface` と `capabilities.tui` は TS が読まない項目（読んでも無視される）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub surface: Surface,
    /// "windows" | "linux" | "macos" | "android" | "ios" | "other"
    pub os: &'static str,
    /// デスクトップ（Tauri なら windows・linux・macos。TUI・CLI はターミナルなので true）
    pub desktop: bool,
    /// Android の Tauri か
    pub android: bool,
    /// この環境での方針（TS の Capabilities と揃える）
    pub capabilities: Capabilities,
}

/// 環境の方針。値は TS の Capabilities と同じ名前・同じ文字列（`tui` だけ TS にはない）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// 共有の設定と下書き（client_storage / LocalStore）を Rust で持つ
    pub shared_storage: bool,
    /// 読取・書込・添付を Rust 経路で行う
    pub rust_api: bool,
    /// チャットの経路: "default"（Rust）・"off"（JS Socket。macOS と、ブラウザー）
    pub rust_chat: &'static str,
    /// 本体の渡し方: "raw"（バイト列）・"base64"（Android の WebView）
    pub body_mode: &'static str,
    /// 通知の出し方: "android"（常駐サービス）・"desktop"（公式の通知）・"bell"（TUI。ターミナルのベル＋画面内表示）・"none"（CLI）
    pub notify_backend: &'static str,
    /// アップデートの経路: "desktop"・"android"・"cli"（CLI・TUI の self-update）・None（対象外）
    pub updater: Option<&'static str>,
    /// 通話の音声出力の切り替えを Kotlin（AudioManager）で行う（Android）
    pub native_audio_output: bool,
    /// 画面を切っても動く常駐（Android の前景サービス）
    pub background_service: bool,
    /// 画面共有の経路: "android"（MediaProjection）・"linux"（PipeWire）・None
    pub native_screen: Option<&'static str>,
    /// 開発用フォルダ（プラグインとテーマ）を使える（Android 以外の Tauri）
    pub dev_folder: bool,
    /// `disnans tui` の環境か（TUI だけ true）
    pub tui: bool,
}

/// 今のビルドの OS 名（`cfg!` で決まる。UA 文字列は使わない）
pub fn host_os() -> &'static str {
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

/// デバイスの事実を組み立てる。`desktop` と `android` は呼び出し側が決める（Tauri の cfg は app 側にあるため）。
pub fn info_for(surface: Surface, os: &'static str, desktop: bool, android: bool) -> PlatformInfo {
    PlatformInfo {
        surface,
        os,
        desktop,
        android,
        capabilities: capabilities_for(surface, os, desktop, android),
    }
}

/// `disnans tui` / `disnans` コマンドの環境（この OS のターミナル）
pub fn terminal_info(surface: Surface) -> PlatformInfo {
    info_for(surface, host_os(), true, false)
}

/// デバイスの事実から方針を決める（この 1 か所だけ）。
/// `Surface::Tauri` の行は、従来の app/src-tauri/src/platform.rs の表と同じ結果になる。
pub fn capabilities_for(surface: Surface, os: &str, desktop: bool, android: bool) -> Capabilities {
    match surface {
        Surface::Tauri => tauri_capabilities(os, desktop, android),
        Surface::Tui => terminal_capabilities(true),
        Surface::Cli => terminal_capabilities(false),
    }
}

fn tauri_capabilities(os: &str, desktop: bool, android: bool) -> Capabilities {
    // Android は S1 のあと、設定と下書きも Rust に寄せる（step6 の (3)。データは app_data_dir）
    let shared_storage = (desktop && matches!(os, "windows" | "linux")) || android;
    Capabilities {
        shared_storage,
        rust_api: shared_storage,
        // Android は既定で Rust（S1）。JS Socket と同じ uid で動くので、背景の条件は同じ
        rust_chat: if shared_storage { "default" } else { "off" },
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
        tui: false,
    }
}

/// ターミナル（TUI・CLI）の方針。どちらも LocalStore と Rust の REST・チャットを使う。違いは TUI の通知（ベル）と tui の印だけ
fn terminal_capabilities(tui: bool) -> Capabilities {
    Capabilities {
        shared_storage: true,
        rust_api: true,
        rust_chat: "default",
        body_mode: "raw",
        notify_backend: if tui { "bell" } else { "none" },
        updater: Some("cli"),
        native_audio_output: false,
        background_service: false,
        native_screen: None,
        dev_folder: false,
        tui,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys_of(value: &serde_json::Value) -> Vec<&str> {
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys
    }

    #[test]
    fn json_has_exactly_the_camel_case_keys() {
        let value = serde_json::to_value(terminal_info(Surface::Tui)).unwrap();
        assert_eq!(
            keys_of(&value),
            ["android", "capabilities", "desktop", "os", "surface"]
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
                "tui",
                "updater",
            ]
        );
        assert_eq!(value["surface"], "tui");
    }

    #[test]
    fn surface_names_are_the_three_documented_values() {
        assert_eq!(serde_json::to_value(Surface::Tauri).unwrap(), "tauri");
        assert_eq!(serde_json::to_value(Surface::Tui).unwrap(), "tui");
        assert_eq!(serde_json::to_value(Surface::Cli).unwrap(), "cli");
    }

    /// Tauri の行は、従来の app/src-tauri/src/platform.rs の表と同じ（V1 で値を変えないこと）
    #[test]
    fn tauri_rows_match_the_previous_table() {
        let win = capabilities_for(Surface::Tauri, "windows", true, false);
        assert!(win.shared_storage && win.rust_api && win.dev_folder);
        assert_eq!(
            (win.rust_chat, win.body_mode, win.native_screen),
            ("default", "raw", None)
        );
        assert_eq!(win.updater, Some("desktop"));
        assert!(!win.tui);

        let linux = capabilities_for(Surface::Tauri, "linux", true, false);
        assert!(linux.shared_storage && linux.rust_api);
        assert_eq!(linux.native_screen, Some("linux"));
        assert_eq!(linux.rust_chat, "default");

        let mac = capabilities_for(Surface::Tauri, "macos", true, false);
        assert!(!mac.shared_storage && !mac.rust_api);
        assert_eq!(mac.rust_chat, "off");
        assert!(mac.dev_folder);
        assert_eq!(mac.native_screen, None);

        let android = capabilities_for(Surface::Tauri, "android", false, true);
        assert!(android.rust_api && android.shared_storage && !android.dev_folder);
        assert_eq!(
            (android.rust_chat, android.body_mode),
            ("default", "base64")
        );
        assert_eq!(android.updater, Some("android"));
        assert_eq!(android.native_screen, Some("android"));
        assert!(android.native_audio_output && android.background_service);
    }

    /// TUI の行（ステップ8 の表）。どの OS でも同じ
    #[test]
    fn tui_row_is_the_terminal_policy_with_bell_and_cli_updates() {
        for os in ["windows", "linux", "macos", "other"] {
            let tui = capabilities_for(Surface::Tui, os, true, false);
            assert!(tui.tui, "{os}");
            assert!(tui.shared_storage && tui.rust_api, "{os}");
            assert_eq!((tui.rust_chat, tui.body_mode), ("default", "raw"), "{os}");
            assert_eq!(tui.notify_backend, "bell", "{os}");
            assert_eq!(tui.updater, Some("cli"), "{os}");
            assert_eq!(tui.native_screen, None, "{os}");
            assert!(
                !tui.dev_folder && !tui.native_audio_output && !tui.background_service,
                "{os}"
            );
        }
    }

    #[test]
    fn cli_row_is_the_same_as_tui_except_no_bell_and_no_tui_flag() {
        let cli = capabilities_for(Surface::Cli, "linux", true, false);
        let tui = capabilities_for(Surface::Tui, "linux", true, false);
        assert!(!cli.tui);
        assert_eq!(cli.notify_backend, "none");
        let expected_tui = Capabilities {
            notify_backend: "bell",
            tui: true,
            ..cli.clone()
        };
        assert_eq!(expected_tui, tui);
    }

    /// この OS のデバイスの判定は、表と一致する（CI の各 OS で走る）
    #[test]
    fn this_host_terminal_reports_the_matching_row() {
        let info = terminal_info(Surface::Tui);
        assert_eq!(info.os, host_os());
        assert_eq!(
            info.capabilities,
            capabilities_for(Surface::Tui, host_os(), true, false)
        );
    }
}
