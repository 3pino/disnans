//! 画面の構造（GUI と TUI が共通に使う宣言的な木）。いまは設定画面とナビゲーションバー。
//!
//! - ここは「どのページに、どの節を、どの部品で、どの順に出すか」だけを決める。値は持たない（値は各 UI が prefs から差し込む）。
//! - GUI は Svelte の部品（`components/ui/`）で、TUI は ratatui で描く。部品の対応は docs/design/tui.md の部品の対応のとおり。
//! - GUI へは `app/src/lib/uiTree.generated.ts` として書き出す（`cargo test -p disnans-client-core` で更新。手で直さない）。
//!   開発用ブラウザーでも同じ木を使えるように、invoke ではなく生成物で渡す。
//! - 片方の UI でしか意味のない項目も木には入れ、`Show` で出し分ける（出さない UI は飛ばす）。
//! - その場の状態で中身が変わるもの（プロフィール・アップデート・機器の一覧など）は `Slot` にして、中身は各 UI が描く。
//! - 説明は docs/design/ui-tree.md。

use serde::Serialize;
use serde_json::Value;

use super::settings::{Def, find_definition};

/// GUI で出す条件（Tauri か・Android か・開発ユーザーか。判断は GUI が行う）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Gui {
    Always,
    Never,
    /// Android の Tauri だけ
    Android,
    /// Android 以外（デスクトップと開発用ブラウザー）
    NotAndroid,
    /// Tauri だけ（開発用ブラウザーでは出さない）
    Tauri,
    /// Tauri か、開発ユーザーのとき
    TauriOrDev,
}

/// どの UI に出すか
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Show {
    pub gui: Gui,
    pub tui: bool,
}

pub const BOTH: Show = Show {
    gui: Gui::Always,
    tui: true,
};
pub const GUI_ONLY: Show = Show {
    gui: Gui::Always,
    tui: false,
};
pub const TUI_ONLY: Show = Show {
    gui: Gui::Never,
    tui: true,
};

/// 選択肢 1 つ。`value` は保存する値、`label` は画面の文言、`icon` はアイコンの名前（Lucide など。TUI は使わない）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Opt {
    pub value: &'static str,
    pub label: &'static str,
    pub icon: Option<&'static str>,
}

const fn opt(value: &'static str, label: &'static str) -> Opt {
    Opt {
        value,
        label,
        icon: None,
    }
}

/// 値を変える部品（GUI の部品 / TUI の部品）
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Control {
    /// Toggle / Toggle
    Toggle,
    /// SegmentedButton / Choice
    Segmented { options: &'static [Opt] },
    /// select / Choice
    Select { options: &'static [Opt] },
    /// Slider / Stepper（数の入力）。画面の値は「保存する値 × scale」（1.0 → 100%）
    Slider {
        min: f64,
        max: f64,
        step: f64,
        scale: f64,
        unit: &'static str,
    },
}

/// 節の中の 1 項目
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    /// 1 つの設定値を部品で変える行（SettingRow + 部品）。
    /// `key` は `DEFINITIONS` のキーか、オブジェクトの中の 1 項目（`enterKeys.enter`）か、[`DERIVED_KEYS`] のどれか
    Field {
        id: &'static str,
        label: &'static str,
        icon: Option<&'static str>,
        key: &'static str,
        control: Control,
        show: Show,
    },
    /// サブページを開く行（行全体がボタン）
    Link {
        id: &'static str,
        label: &'static str,
        page: &'static str,
        show: Show,
    },
    /// 各 UI が中身を描く場所。`id` で何を描くかを決める
    Slot { id: &'static str, show: Show },
    /// 補足の文（控えめな色）
    Note {
        id: &'static str,
        text: &'static str,
        show: Show,
    },
}

impl Item {
    pub fn id(&self) -> &'static str {
        match self {
            Item::Field { id, .. }
            | Item::Link { id, .. }
            | Item::Slot { id, .. }
            | Item::Note { id, .. } => id,
        }
    }

    pub fn show(&self) -> Show {
        match self {
            Item::Field { show, .. }
            | Item::Link { show, .. }
            | Item::Slot { show, .. }
            | Item::Note { show, .. } => *show,
        }
    }
}

/// 見出しつきの節（Section / Section）
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Section {
    pub id: &'static str,
    pub title: &'static str,
    pub items: &'static [Item],
    pub show: Show,
}

/// 1 ページ（設定のトップと、そのサブページ）
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Page {
    pub id: &'static str,
    pub title: &'static str,
    pub sections: &'static [Section],
    pub show: Show,
}

/// 保存する値から UI が計算する項目（`DEFINITIONS` のキーではない）。TUI には出さない（テストで確かめる）
/// - `limiterStrength`: 大きい音を抑える強さ（`limiter` と `limitDb` から。`call/pure.ts` の `limiterStrength`）
pub const DERIVED_KEYS: &[&str] = &["limiterStrength"];

/// 設定のトップのページ
pub const SETTINGS_TOP: &str = "top";

const THEME_OPTIONS: &[Opt] = &[
    Opt {
        value: "system",
        label: "自動",
        icon: Some("monitor"),
    },
    Opt {
        value: "light",
        label: "ライト",
        icon: Some("sun"),
    },
    Opt {
        value: "dark",
        label: "ダーク",
        icon: Some("moon"),
    },
];

const ORIENTATION_OPTIONS: &[Opt] = &[
    opt("portrait", "向きを固定"),
    opt("media", "メディアのみ自動回転"),
    opt("auto", "自動回転"),
];

const ENTER_OPTIONS: &[Opt] = &[
    opt("send", "送信"),
    opt("newline", "改行"),
    opt("none", "なし"),
];

const LIMITER_OPTIONS: &[Opt] = &[
    opt("none", "なし"),
    opt("weak", "弱"),
    opt("medium", "中"),
    opt("strong", "強"),
];

const fn enter_field(id: &'static str, label: &'static str, key: &'static str) -> Item {
    Item::Field {
        id,
        label,
        icon: None,
        key,
        control: Control::Segmented {
            options: ENTER_OPTIONS,
        },
        show: BOTH,
    }
}

const fn slot(id: &'static str, show: Show) -> Item {
    Item::Slot { id, show }
}

const fn link(id: &'static str, label: &'static str, page: &'static str, show: Show) -> Item {
    Item::Link {
        id,
        label,
        page,
        show,
    }
}

/// 設定のページ。先頭がトップ。サブページの `id` は GUI の `SettingsSubpage`（navHistory.ts）と同じ
pub const SETTINGS_PAGES: &[Page] = &[
    Page {
        id: SETTINGS_TOP,
        title: "設定",
        show: BOTH,
        sections: &[
            Section {
                id: "profile",
                title: "プロフィール",
                show: GUI_ONLY,
                items: &[slot("profile", GUI_ONLY)],
            },
            Section {
                id: "appearance",
                title: "外観",
                show: BOTH,
                items: &[
                    Item::Field {
                        id: "theme",
                        label: "テーマ",
                        icon: None,
                        key: "theme",
                        control: Control::Segmented {
                            options: THEME_OPTIONS,
                        },
                        show: BOTH,
                    },
                    slot("customThemes", GUI_ONLY),
                    Item::Field {
                        id: "orientation",
                        label: "画面の向き",
                        icon: None,
                        key: "orientation",
                        control: Control::Select {
                            options: ORIENTATION_OPTIONS,
                        },
                        show: Show {
                            gui: Gui::Android,
                            tui: false,
                        },
                    },
                    Item::Field {
                        id: "hideNavigationBar",
                        label: "ナビゲーションバーを隠す",
                        icon: None,
                        key: "hideNavigationBar",
                        control: Control::Toggle,
                        show: Show {
                            gui: Gui::Android,
                            tui: false,
                        },
                    },
                ],
            },
            Section {
                id: "operations",
                title: "操作",
                show: BOTH,
                items: &[
                    link("enterKeys", "入力欄のキー", "enterKeys", BOTH),
                    link(
                        "hotkeys",
                        "ホットキー",
                        "hotkeys",
                        Show {
                            gui: Gui::NotAndroid,
                            tui: false,
                        },
                    ),
                    link("tuiKeys", "キー割り当て", "tuiKeys", TUI_ONLY),
                    link("navBar", "ナビゲーションバー", "navBar", GUI_ONLY),
                    link("composerMenu", "＋メニュー", "composerMenu", GUI_ONLY),
                    link("call", "通話", "call", GUI_ONLY),
                ],
            },
            Section {
                id: "notifications",
                title: "通知",
                show: GUI_ONLY,
                items: &[slot("notifications", GUI_ONLY)],
            },
            Section {
                id: "plugins",
                title: "プラグイン",
                show: GUI_ONLY,
                items: &[slot("plugins", GUI_ONLY)],
            },
            Section {
                id: "connection",
                title: "接続",
                show: Show {
                    gui: Gui::TauriOrDev,
                    tui: true,
                },
                items: &[
                    slot(
                        "server",
                        Show {
                            gui: Gui::TauriOrDev,
                            tui: true,
                        },
                    ),
                    link(
                        "devices",
                        "デバイス",
                        "devices",
                        Show {
                            gui: Gui::Tauri,
                            tui: true,
                        },
                    ),
                ],
            },
            Section {
                id: "app",
                title: "アプリ",
                show: BOTH,
                items: &[slot("version", BOTH)],
            },
        ],
    },
    Page {
        id: "enterKeys",
        title: "入力欄のキー",
        show: BOTH,
        sections: &[Section {
            id: "enterKeys",
            title: "入力欄のキー",
            show: BOTH,
            items: &[
                enter_field("enterKeys.enter", "Enter", "enterKeys.enter"),
                enter_field("enterKeys.shift", "Shift+Enter", "enterKeys.shift"),
                enter_field("enterKeys.ctrl", "Ctrl+Enter", "enterKeys.ctrl"),
                enter_field("enterKeys.alt", "Alt+Enter", "enterKeys.alt"),
                Item::Note {
                    id: "enterKeysNote",
                    text: "メッセージの編集では「送信」が保存になります。この設定はほかのデバイスとも共有されます",
                    show: BOTH,
                },
            ],
        }],
    },
    Page {
        id: "hotkeys",
        title: "ホットキー",
        show: Show {
            gui: Gui::NotAndroid,
            tui: false,
        },
        sections: &[Section {
            id: "hotkeys",
            title: "ホットキー",
            show: GUI_ONLY,
            items: &[slot("hotkeys", GUI_ONLY)],
        }],
    },
    Page {
        id: "tuiKeys",
        title: "キー割り当て",
        show: TUI_ONLY,
        sections: &[Section {
            id: "tuiKeys",
            title: "キー割り当て",
            show: TUI_ONLY,
            items: &[slot("tuiKeys", TUI_ONLY)],
        }],
    },
    Page {
        id: "navBar",
        title: "ナビゲーションバー",
        show: GUI_ONLY,
        sections: &[Section {
            id: "navBar",
            title: "ナビゲーションバー",
            show: GUI_ONLY,
            items: &[slot("navBar", GUI_ONLY)],
        }],
    },
    Page {
        id: "composerMenu",
        title: "＋メニュー",
        show: GUI_ONLY,
        sections: &[Section {
            id: "composerMenu",
            title: "＋メニュー",
            show: GUI_ONLY,
            items: &[slot("composerMenu", GUI_ONLY)],
        }],
    },
    Page {
        id: "call",
        title: "通話",
        show: GUI_ONLY,
        sections: &[Section {
            id: "call",
            title: "通話",
            show: GUI_ONLY,
            items: &[
                Item::Field {
                    id: "joinMuted",
                    label: "参加したときミュートにする",
                    icon: Some("mic-off"),
                    key: "joinMuted",
                    control: Control::Toggle,
                    show: GUI_ONLY,
                },
                Item::Field {
                    id: "micVolume",
                    label: "マイクの音量",
                    icon: Some("mic"),
                    key: "micVolume",
                    control: Control::Slider {
                        min: 0.0,
                        max: 200.0,
                        step: 5.0,
                        scale: 100.0,
                        unit: "%",
                    },
                    show: GUI_ONLY,
                },
                Item::Field {
                    id: "outVolume",
                    label: "相手の音量",
                    icon: Some("volume-2"),
                    key: "outVolume",
                    control: Control::Slider {
                        min: 0.0,
                        max: 100.0,
                        step: 5.0,
                        scale: 100.0,
                        unit: "%",
                    },
                    show: GUI_ONLY,
                },
                Item::Field {
                    id: "limiterStrength",
                    label: "大きい音を抑える",
                    icon: Some("shield-check"),
                    key: "limiterStrength",
                    control: Control::Segmented {
                        options: LIMITER_OPTIONS,
                    },
                    show: GUI_ONLY,
                },
                // 機器の一覧は開いたときに取り、使えない環境では行ごと出さない
                slot("callDevices", GUI_ONLY),
            ],
        }],
    },
    Page {
        id: "devices",
        title: "デバイス",
        show: Show {
            gui: Gui::Tauri,
            tui: true,
        },
        sections: &[Section {
            id: "devices",
            title: "デバイス",
            show: Show {
                gui: Gui::Tauri,
                tui: true,
            },
            items: &[slot(
                "deviceList",
                Show {
                    gui: Gui::Tauri,
                    tui: true,
                },
            )],
        }],
    },
];

/// ページを ID で探す
pub fn settings_page(id: &str) -> Option<&'static Page> {
    SETTINGS_PAGES.iter().find(|p| p.id == id)
}

/// `Field` の `key` を、定義と（オブジェクトの中の項目なら）その項目名にする。派生の項目（[`DERIVED_KEYS`]）と、知らないキーは `None`
pub fn resolve_key(key: &str) -> Option<(&'static Def, Option<&str>)> {
    match key.split_once('.') {
        Some((head, sub)) => find_definition(head).map(|d| (d, Some(sub))),
        None => find_definition(key).map(|d| (d, None)),
    }
}

/// prefs（正規化したもの）から、`Field` の今の値を取り出す。無ければ定義の既定値
pub fn field_value(prefs: &Value, key: &str) -> Option<Value> {
    let (def, sub) = resolve_key(key)?;
    let whole = prefs
        .get(def.key)
        .cloned()
        .unwrap_or_else(|| super::settings::default_of(def));
    match sub {
        None => Some(whole),
        Some(sub) => {
            let default = super::settings::default_of(def);
            whole.get(sub).or_else(|| default.get(sub)).cloned()
        }
    }
}

/// 選択肢の文言（無ければ値そのもの）
pub fn option_label(options: &[Opt], value: &str) -> String {
    options
        .iter()
        .find(|o| o.value == value)
        .map_or_else(|| value.to_owned(), |o| o.label.to_owned())
}

// ---- ナビゲーションバー ----

/// ナビゲーションバーに出せる本体の項目。`label` は既定の短い名前（無ければ `name`）、`name` はコマンドの名前（GUI のコマンドと同じ）。
/// `tui` は TUI に画面があるか（無いものは TUI のバーに出さない）。プラグインのコマンドは TUI には出さない
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NavItem {
    pub id: &'static str,
    pub label: Option<&'static str>,
    pub name: &'static str,
    pub tui: bool,
}

pub const NAV_CHAT_ID: &str = "app:open-chat";
pub const NAV_SETTINGS_ID: &str = "app:open-settings";
pub const NAV_SEARCH_ID: &str = "app:search";
pub const NAV_CALL_ID: &str = "app:call-open";
pub const NAV_FILES_ID: &str = "app:open-files";

pub const NAV_ITEMS: &[NavItem] = &[
    NavItem {
        id: NAV_CHAT_ID,
        label: Some("Chat"),
        name: "チャットを開く",
        tui: true,
    },
    NavItem {
        id: NAV_SETTINGS_ID,
        label: Some("Settings"),
        name: "設定を開く",
        tui: true,
    },
    NavItem {
        id: NAV_CALL_ID,
        label: Some("Call"),
        name: "通話を開く",
        tui: false,
    },
    NavItem {
        id: NAV_SEARCH_ID,
        label: Some("Search"),
        name: "メッセージを検索",
        tui: true,
    },
    NavItem {
        id: NAV_FILES_ID,
        label: None,
        name: "共有フォルダを開く",
        tui: false,
    },
];

/// 項目の表示名（`navBar.ts` の `navItemLabel` と同じ規則）。
/// 未設定 → 既定の短い名前（無ければコマンド名）、設定済みで空欄 → コマンド名、設定済み → その名前。コマンド名が分からなければ ID
pub fn nav_label(id: &str, command_name: Option<&str>, labels: &Value) -> String {
    let item = NAV_ITEMS.iter().find(|i| i.id == id);
    let fallback = command_name
        .or(item.map(|i| i.name))
        .unwrap_or(id)
        .to_owned();
    match labels.get(id).and_then(Value::as_str) {
        Some("") => fallback,
        Some(set) => set.to_owned(),
        None => item.and_then(|i| i.label).map_or(fallback, str::to_owned),
    }
}

/// TUI のバーに出す項目（ID と表示名）。並びはユーザー共通の `navBarItems`（正規化したもの）、表示名は `navBarLabels`。
/// TUI に画面のない項目（通話・共有フォルダ・プラグイン）は飛ばす。チャットと設定は必ず出す
pub fn tui_nav_items(user_prefs: &Value) -> Vec<(&'static str, String)> {
    let labels = user_prefs
        .get("navBarLabels")
        .cloned()
        .unwrap_or(Value::Null);
    let mut ids: Vec<&'static str> = Vec::new();
    if let Some(list) = user_prefs.get("navBarItems").and_then(Value::as_array) {
        for id in list.iter().filter_map(Value::as_str) {
            if let Some(item) = NAV_ITEMS.iter().find(|i| i.id == id && i.tui)
                && !ids.contains(&item.id)
            {
                ids.push(item.id);
            }
        }
    }
    for required in [NAV_CHAT_ID, NAV_SETTINGS_ID] {
        if !ids.contains(&required) {
            ids.push(required);
        }
    }
    ids.into_iter()
        .map(|id| (id, nav_label(id, None, &labels)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all_items() -> impl Iterator<Item = (&'static Page, &'static Section, &'static Item)> {
        SETTINGS_PAGES.iter().flat_map(|p| {
            p.sections
                .iter()
                .flat_map(move |s| s.items.iter().map(move |i| (p, s, i)))
        })
    }

    #[test]
    fn page_ids_are_unique_and_links_point_to_pages() {
        let mut ids: Vec<&str> = SETTINGS_PAGES.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        assert_eq!(SETTINGS_PAGES[0].id, SETTINGS_TOP);
        for (_, _, item) in all_items() {
            if let Item::Link { page, show, .. } = item {
                let target = settings_page(page).unwrap_or_else(|| panic!("{page} is a page"));
                // リンクを出す UI では、行き先のページも出す
                assert!(!show.tui || target.show.tui, "{page} for tui");
                assert!(show.gui == Gui::Never || target.show.gui != Gui::Never);
            }
        }
    }

    #[test]
    fn item_ids_are_unique_within_a_page() {
        for page in SETTINGS_PAGES {
            let mut ids: Vec<&str> = page
                .sections
                .iter()
                .flat_map(|s| s.items.iter().map(Item::id))
                .collect();
            ids.sort_unstable();
            let n = ids.len();
            ids.dedup();
            assert_eq!(ids.len(), n, "page {}", page.id);
        }
    }

    #[test]
    fn field_keys_resolve_to_definitions_and_options_are_valid() {
        for (_, _, item) in all_items() {
            let Item::Field {
                key, control, show, ..
            } = item
            else {
                continue;
            };
            if DERIVED_KEYS.contains(key) {
                assert!(!show.tui, "{key}: TUI は派生の項目を保存できない");
                continue;
            }
            let (def, sub) = resolve_key(key).unwrap_or_else(|| panic!("{key} is defined"));
            let options = match control {
                Control::Segmented { options } | Control::Select { options } => options,
                _ => continue,
            };
            let default = default_of_field(def, sub);
            // 既定値は選択肢の 1 つ（選択肢は定義の選択肢の範囲）
            assert!(
                options.iter().any(|o| Some(o.value) == default.as_str()),
                "{key} default {default}"
            );
            for o in options.iter() {
                let mut value = super::super::settings::default_of(def);
                match sub {
                    None => value = json!(o.value),
                    Some(sub) => value[sub] = json!(o.value),
                }
                assert_eq!(
                    super::super::settings::normalize_value(def, Some(&value)),
                    value,
                    "{key} option {}",
                    o.value
                );
            }
        }
    }

    fn default_of_field(def: &Def, sub: Option<&str>) -> Value {
        let whole = super::super::settings::default_of(def);
        sub.map_or(whole.clone(), |s| whole[s].clone())
    }

    #[test]
    fn hidden_sections_hide_their_items() {
        for (page, section, item) in all_items() {
            let s = item.show();
            assert!(
                !s.tui || (section.show.tui && page.show.tui),
                "{}",
                item.id()
            );
            assert!(s.gui == Gui::Never || section.show.gui != Gui::Never);
        }
    }

    #[test]
    fn field_value_reads_sub_keys_and_defaults() {
        let prefs = json!({"theme": "dark", "enterKeys": {"enter": "send"}});
        assert_eq!(field_value(&prefs, "theme"), Some(json!("dark")));
        assert_eq!(field_value(&prefs, "enterKeys.enter"), Some(json!("send")));
        assert_eq!(
            field_value(&prefs, "enterKeys.ctrl"),
            Some(json!("send")),
            "default"
        );
        assert_eq!(field_value(&json!({}), "theme"), Some(json!("system")));
        assert_eq!(field_value(&prefs, "limiterStrength"), None);
        assert_eq!(option_label(THEME_OPTIONS, "dark"), "ダーク");
        assert_eq!(option_label(THEME_OPTIONS, "x"), "x");
    }

    #[test]
    fn nav_labels_follow_the_gui_rules() {
        let labels = json!({"app:open-chat": "会話", "app:open-settings": ""});
        assert_eq!(nav_label(NAV_CHAT_ID, None, &labels), "会話");
        assert_eq!(nav_label(NAV_SETTINGS_ID, None, &labels), "設定を開く");
        assert_eq!(nav_label(NAV_SEARCH_ID, None, &labels), "Search");
        assert_eq!(nav_label(NAV_FILES_ID, None, &labels), "共有フォルダを開く");
        assert_eq!(nav_label("dice:roll", Some("振る"), &labels), "振る");
        assert_eq!(nav_label("dice:roll", None, &labels), "dice:roll");
    }

    #[test]
    fn tui_nav_follows_the_order_and_skips_what_the_tui_cannot_open() {
        let prefs = json!({
            "navBarItems": ["app:open-settings", "dice:roll", "app:call-open", "app:search", "app:open-chat"],
            "navBarLabels": {"app:search": "探す"},
        });
        assert_eq!(
            tui_nav_items(&prefs),
            vec![
                (NAV_SETTINGS_ID, "Settings".to_owned()),
                (NAV_SEARCH_ID, "探す".to_owned()),
                (NAV_CHAT_ID, "Chat".to_owned()),
            ]
        );
        assert_eq!(
            tui_nav_items(&json!({})),
            vec![
                (NAV_CHAT_ID, "Chat".to_owned()),
                (NAV_SETTINGS_ID, "Settings".to_owned())
            ]
        );
    }
}
