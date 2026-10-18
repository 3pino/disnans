//! 設定項目の定義（ステップ8・V5）。キー・保存先（scope）・型・既定値を、ここの一か所に置く。
//!
//! 保存先の分類（docs/PLAN_SERVER_SETTINGS.md）:
//! - `User`: ユーザー共通。サーバーの `/api/me/prefs` に置く（この表は値の形と既定を決めるだけ）。
//! - `Device`: 端末ごと。サーバーの `/api/me/devices/{id}/prefs` に置く（`normalize_device_prefs` で正規化する）。
//! - `Local`: この端末だけ。サーバーには送らない（接続先・開発用の値・更新の確認など）。
//!
//! GUI の既存の保存先（localStorage のキー）の移行は GUI 側の作業。ここのキーは、サーバーに置く JSON の項目名。
//! 既定値は、GUI が今使っている値と同じにする（`DEFAULT_CALL_SETTINGS` など。変えるときは理由を残す）。

use serde::Serialize;
use serde_json::{Map, Value};

/// 保存先
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    Device,
    Local,
}

/// 値の型
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Bool,
    /// 数。有限な数だけ受け、範囲の外は範囲内に収める
    Number {
        min: f64,
        max: f64,
    },
    /// 文字列の選択肢。`nullable` なら null も受ける
    Choice {
        options: &'static [&'static str],
        nullable: bool,
    },
    /// 文字列（空を含む）
    Text,
    /// 文字列、または null（`null` は「未設定」）
    NullableText,
    /// 文字列の配列
    TextList,
    /// 形を問わない JSON（オブジェクトなど。中身は GUI が決める）
    Any,
    /// ホットキー（コマンド ID → キーの一覧）。`prefs.svelte`・`commands.svelte.ts` の `normalizeHotkeys` と同じ
    HotkeyMap,
    /// スラッシュコマンドの別名（コマンド ID → 名前）。`slashAlias.ts` の `normalizeSlashAliases` と同じ
    SlashAliases,
    /// Enter の動作（enter・shift・ctrl・alt）。`enterKeys.ts` の `normalizeEnterKeys` と同じ
    EnterKeys,
    /// 「＋」メニューの並び・隠す項目。`composerMenu.ts` の `normalizeComposerMenu` と同じ
    ComposerMenu,
    /// ナビの項目の並び（`navBar.ts` の `normalizeNavItems`）。削除した項目は捨て、本体の 2 つは必ず入れる
    NavItems,
}

/// 既定値
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DefaultValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(&'static str),
    EmptyList,
    EmptyObject,
    /// JSON の値（テキスト）。定義の中で書く。正しい JSON であること（テストで確かめる）
    Json(&'static str),
}

impl DefaultValue {
    fn to_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(b) => Value::Bool(b),
            Self::Number(n) => serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number),
            Self::Text(s) => Value::String(s.to_owned()),
            Self::EmptyList => Value::Array(Vec::new()),
            Self::EmptyObject => Value::Object(Map::new()),
            Self::Json(text) => serde_json::from_str(text).unwrap_or(Value::Null),
        }
    }
}

/// 設定項目 1 つ
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Def {
    pub key: &'static str,
    pub scope: Scope,
    pub kind: Kind,
    pub default: DefaultValue,
}

/// 文字列の選択肢の候補（`Kind::Choice`）
pub const ORIENTATION_OPTIONS: &[&str] = &["portrait", "media", "auto"];
pub const DEVICE_KIND_OPTIONS: &[&str] = &["smartphone", "tablet", "laptop", "monitor"];
pub const THEME_OPTIONS: &[&str] = &["system", "light", "dark"];
/// メッセージの表示（`messageLayout.ts`）
pub const MESSAGE_LAYOUT_OPTIONS: &[&str] = &["list", "bubble"];
/// Enter キーの動作（`enterKeys.ts` の ACTIONS）と組み合わせ
const ENTER_ACTIONS: &[&str] = &["send", "newline", "none"];
const ENTER_COMBOS: &[&str] = &["enter", "shift", "ctrl", "alt"];
/// ナビの既定の並び（`DEFAULT_NAV_ITEMS`）。本体の 2 つ
const NAV_ITEMS_DEFAULT: &str = r#"["app:open-chat","app:open-settings"]"#;
/// 削除した項目（`NAV_REMOVED_IDS`）。読むときに捨てる
const NAV_REMOVED_IDS: &[&str] = &["app:open-threads"];
/// 必ず出す項目（`NAV_REQUIRED_IDS`）。無ければ末尾に足す
const NAV_REQUIRED_IDS: &[&str] = &["app:open-chat", "app:open-settings"];
/// 既定: Enter・Shift+Enter は改行、Ctrl+Enter・Alt+Enter は送信（`DEFAULT_ENTER_KEYS`）
const ENTER_KEYS_DEFAULT: &str =
    r#"{"enter":"newline","shift":"newline","ctrl":"send","alt":"send"}"#;

/// 通話の上限（dBFS）。`call/pure.ts` の `LIMIT_DB_MIN` / `LIMIT_DB_MAX` / `LIMIT_DB_DEFAULT` と同じ
pub const LIMIT_DB_MIN: f64 = -18.0;
pub const LIMIT_DB_MAX: f64 = -3.0;
pub const LIMIT_DB_DEFAULT: f64 = -6.0;
/// マイクの音量の上限（等倍が 1）。`call/pure.ts` の `MIC_VOLUME_MAX`
pub const MIC_VOLUME_MAX: f64 = 2.0;
/// 相手の音量の上限。`call/pure.ts` の `OUT_VOLUME_MAX`
pub const OUT_VOLUME_MAX: f64 = 1.0;

/// 設定項目の一覧。順序は表示や一覧の都合で変えてよいが、キーは変えない（サーバーに保存済みの値の名前）
pub const DEFINITIONS: &[Def] = &[
    // ---- ユーザー共通（サーバーの prefs）----
    Def {
        key: "theme",
        scope: Scope::User,
        kind: Kind::Choice {
            options: THEME_OPTIONS,
            nullable: false,
        },
        default: DefaultValue::Text("system"),
    },
    Def {
        key: "customTheme",
        scope: Scope::User,
        kind: Kind::NullableText,
        default: DefaultValue::Null,
    },
    Def {
        key: "navBarItems",
        scope: Scope::User,
        kind: Kind::NavItems,
        default: DefaultValue::Json(NAV_ITEMS_DEFAULT),
    },
    Def {
        key: "navBarLabels",
        scope: Scope::User,
        kind: Kind::Any,
        default: DefaultValue::EmptyObject,
    },
    Def {
        key: "joinMuted",
        scope: Scope::User,
        kind: Kind::Bool,
        default: DefaultValue::Bool(false),
    },
    Def {
        key: "micVolume",
        scope: Scope::User,
        kind: Kind::Number {
            min: 0.0,
            max: MIC_VOLUME_MAX,
        },
        default: DefaultValue::Number(1.0),
    },
    Def {
        key: "outVolume",
        scope: Scope::User,
        kind: Kind::Number {
            min: 0.0,
            max: OUT_VOLUME_MAX,
        },
        default: DefaultValue::Number(1.0),
    },
    Def {
        key: "limiter",
        scope: Scope::User,
        kind: Kind::Bool,
        default: DefaultValue::Bool(true),
    },
    Def {
        key: "limitDb",
        scope: Scope::User,
        kind: Kind::Number {
            min: LIMIT_DB_MIN,
            max: LIMIT_DB_MAX,
        },
        default: DefaultValue::Number(LIMIT_DB_DEFAULT),
    },
    Def {
        key: "hotkeys",
        scope: Scope::User,
        kind: Kind::HotkeyMap,
        default: DefaultValue::EmptyObject,
    },
    Def {
        key: "slashNames",
        scope: Scope::User,
        kind: Kind::SlashAliases,
        default: DefaultValue::EmptyObject,
    },
    Def {
        key: "enterKeys",
        scope: Scope::User,
        kind: Kind::EnterKeys,
        default: DefaultValue::Json(ENTER_KEYS_DEFAULT),
    },
    Def {
        key: "composerMenu",
        scope: Scope::User,
        kind: Kind::ComposerMenu,
        default: DefaultValue::Json(r#"{"order":[],"hidden":[]}"#),
    },
    Def {
        key: "messageLayout",
        scope: Scope::User,
        kind: Kind::Choice {
            options: MESSAGE_LAYOUT_OPTIONS,
            nullable: false,
        },
        default: DefaultValue::Text("list"),
    },
    // ---- 端末ごと（サーバーの端末の prefs）----
    Def {
        key: "inputId",
        scope: Scope::Device,
        kind: Kind::Text,
        default: DefaultValue::Text(""),
    },
    Def {
        key: "output",
        scope: Scope::Device,
        kind: Kind::Any,
        default: DefaultValue::Null,
    },
    Def {
        key: "deviceKind",
        scope: Scope::Device,
        kind: Kind::Choice {
            options: DEVICE_KIND_OPTIONS,
            nullable: true,
        },
        default: DefaultValue::Null,
    },
    Def {
        key: "hideNavigationBar",
        scope: Scope::Device,
        kind: Kind::Bool,
        default: DefaultValue::Bool(false),
    },
    Def {
        key: "orientation",
        scope: Scope::Device,
        kind: Kind::Choice {
            options: ORIENTATION_OPTIONS,
            nullable: false,
        },
        default: DefaultValue::Text("auto"),
    },
    Def {
        key: "pluginsDisabled",
        scope: Scope::Device,
        kind: Kind::TextList,
        default: DefaultValue::EmptyList,
    },
    Def {
        key: "pluginsDevDir",
        scope: Scope::Device,
        kind: Kind::NullableText,
        default: DefaultValue::Null,
    },
    // ---- この端末だけ（サーバーに送らない。キーは移行の目印として一覧に置く）----
    Def {
        key: "server",
        scope: Scope::Local,
        kind: Kind::NullableText,
        default: DefaultValue::Null,
    },
    Def {
        key: "devUser",
        scope: Scope::Local,
        kind: Kind::NullableText,
        default: DefaultValue::Null,
    },
    Def {
        key: "updateCheckedAt",
        scope: Scope::Local,
        kind: Kind::Number {
            min: 0.0,
            max: f64::MAX,
        },
        default: DefaultValue::Null,
    },
    Def {
        key: "updateNotifiedVersion",
        scope: Scope::Local,
        kind: Kind::NullableText,
        default: DefaultValue::Null,
    },
];

/// 端末ごとの項目（`/api/me/devices/{id}/prefs` の中身）
pub fn device_definitions() -> impl Iterator<Item = &'static Def> {
    DEFINITIONS.iter().filter(|d| d.scope == Scope::Device)
}

/// 既定値の端末ごとの設定（オブジェクト）
pub fn device_defaults() -> Value {
    Value::Object(
        device_definitions()
            .map(|d| (d.key.to_owned(), d.default.to_value()))
            .collect(),
    )
}

/// 1 つの値を定義に合わせる。合わなければ既定値にする（数だけは範囲に収める）。
pub fn normalize_value(def: &Def, value: Option<&Value>) -> Value {
    let fallback = || def.default.to_value();
    match (def.kind, value) {
        (Kind::Bool, Some(Value::Bool(b))) => Value::Bool(*b),
        (Kind::Number { min, max }, Some(v)) => match v.as_f64() {
            Some(n) if n.is_finite() => {
                let n = n.clamp(min, max);
                serde_json::Number::from_f64(n).map_or_else(fallback, Value::Number)
            }
            _ => fallback(),
        },
        (Kind::Choice { options, nullable }, Some(v)) => match v {
            Value::String(s) if options.contains(&s.as_str()) => v.clone(),
            Value::Null if nullable => Value::Null,
            _ => fallback(),
        },
        (Kind::Text, Some(Value::String(s))) => Value::String(s.clone()),
        (Kind::NullableText, Some(Value::String(s))) => Value::String(s.clone()),
        (Kind::NullableText, Some(Value::Null)) => Value::Null,
        (Kind::TextList, Some(Value::Array(items))) if items.iter().all(Value::is_string) => {
            Value::Array(items.clone())
        }
        (Kind::Any, Some(v)) if !v.is_null() => v.clone(),
        (Kind::HotkeyMap, Some(v)) => hotkey_map(v),
        (Kind::SlashAliases, Some(v)) => slash_aliases(v),
        (Kind::EnterKeys, Some(v)) => enter_keys(v),
        (Kind::ComposerMenu, Some(v)) => composer_menu(v),
        (Kind::NavItems, Some(v)) => nav_items(v),
        (_, None) => fallback(),
        _ => fallback(),
    }
}

/// 既定の値（定義の既定を JSON にしたもの）
pub fn default_of(def: &Def) -> Value {
    def.default.to_value()
}

/// `normalizeNavItems`: 配列でなければ既定。空でない文字列の重複なしで、削除した項目を除き、必須の項目を末尾に足す
fn nav_items(raw: &Value) -> Value {
    let Value::Array(items) = raw else {
        return default_of(find_definition("navBarItems").expect("navBarItems is defined"));
    };
    let mut out: Vec<Value> = unique_strings(items)
        .into_iter()
        .filter(|v| !v.as_str().is_some_and(|s| NAV_REMOVED_IDS.contains(&s)))
        .collect();
    for id in NAV_REQUIRED_IDS {
        if !out.iter().any(|v| v.as_str() == Some(*id)) {
            out.push(Value::String((*id).to_owned()));
        }
    }
    Value::Array(out)
}

/// 定義をキーで探す
pub fn find_definition(key: &str) -> Option<&'static Def> {
    DEFINITIONS.iter().find(|d| d.key == key)
}

/// 文字列の一覧（空でない文字列だけ、重複は最初の 1 つ。順序は保つ）
fn unique_strings(items: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for item in items {
        if let Value::String(s) = item
            && !s.is_empty()
            && !out.iter().any(|v| v == item)
        {
            out.push(item.clone());
        }
    }
    out
}

/// `normalizeHotkeys`: 文字列は 1 つの組み合わせ（空は「なし」）、配列は空でない文字列の重複なし一覧。ほかは捨てる
fn hotkey_map(raw: &Value) -> Value {
    let Value::Object(map) = raw else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (id, v) in map {
        match v {
            Value::String(s) if s.is_empty() => {
                out.insert(id.clone(), Value::Array(Vec::new()));
            }
            Value::String(_) => {
                out.insert(id.clone(), Value::Array(vec![v.clone()]));
            }
            Value::Array(items) => {
                out.insert(id.clone(), Value::Array(unique_strings(items)));
            }
            _ => {}
        }
    }
    Value::Object(out)
}

/// `normalizeSlashAliases`: 文字列で、`^[a-z0-9][a-z0-9-]{0,31}$` に合うものだけ
fn slash_aliases(raw: &Value) -> Value {
    let Value::Object(map) = raw else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (id, v) in map {
        if let Value::String(s) = v
            && is_slash_name(s)
        {
            out.insert(id.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// `SLASH_NAME_RE`（`slashCommands.svelte.ts`）と同じ: 先頭は英小文字か数字、以後は英小文字・数字・ハイフン、全体 32 字まで
pub fn is_slash_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes
            .iter()
            .enumerate()
            .all(|(i, &b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'-'))
}

/// `normalizeEnterKeys`: 4 つの組み合わせだけを持つ。読めない項目は既定（`enter`・`shift` は改行、`ctrl`・`alt` は送信）
fn enter_keys(raw: &Value) -> Value {
    let mut out = match DefaultValue::Json(ENTER_KEYS_DEFAULT).to_value() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Value::Object(map) = raw {
        for combo in ENTER_COMBOS {
            if let Some(Value::String(action)) = map.get(*combo)
                && ENTER_ACTIONS.contains(&action.as_str())
            {
                out.insert((*combo).to_owned(), Value::String(action.clone()));
            }
        }
    }
    Value::Object(out)
}

/// `normalizeComposerMenu`: `order` と `hidden` だけを、空でない文字列の重複なしの一覧で持つ。他の項目（版の印など）は入れない
fn composer_menu(raw: &Value) -> Value {
    let strings = |key: &str| -> Value {
        match raw.get(key) {
            Some(Value::Array(items)) => Value::Array(unique_strings(items)),
            _ => Value::Array(Vec::new()),
        }
    };
    if !raw.is_object() {
        return serde_json::json!({"order": [], "hidden": []});
    }
    serde_json::json!({"order": strings("order"), "hidden": strings("hidden")})
}

/// 端末ごとの設定を正規化する。項目の型が合わないものは既定値に、足りないものは既定値で埋める。
/// 定義に無いキーは、新しい版が書いたものかもしれないので、そのまま残す（消さない）。
/// オブジェクトでない値は、すべて既定値にする。
pub fn normalize_device_prefs(raw: &Value) -> Value {
    let mut out = match raw {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for def in device_definitions() {
        let value = normalize_value(def, raw.get(def.key));
        out.insert(def.key.to_owned(), value);
    }
    Value::Object(out)
}

/// 保存する値の検査用に、定義の一覧を JSON にする（GUI が起動時に一度読む想定）
pub fn definitions_json() -> Value {
    Value::Array(
        DEFINITIONS
            .iter()
            .map(|d| {
                serde_json::json!({
                    "key": d.key,
                    "scope": d.scope,
                    "default": d.default.to_value(),
                    "kind": kind_json(d.kind),
                })
            })
            .collect(),
    )
}

fn kind_json(kind: Kind) -> Value {
    match kind {
        Kind::Bool => serde_json::json!({"type": "bool"}),
        Kind::Number { min, max } => serde_json::json!({"type": "number", "min": min, "max": max}),
        Kind::Choice { options, nullable } => {
            serde_json::json!({"type": "choice", "options": options, "nullable": nullable})
        }
        Kind::Text => serde_json::json!({"type": "text"}),
        Kind::NullableText => serde_json::json!({"type": "nullableText"}),
        Kind::TextList => serde_json::json!({"type": "textList"}),
        Kind::Any => serde_json::json!({"type": "any"}),
        Kind::HotkeyMap => serde_json::json!({"type": "hotkeyMap"}),
        Kind::SlashAliases => serde_json::json!({"type": "slashAliases"}),
        Kind::EnterKeys => serde_json::json!({"type": "enterKeys"}),
        Kind::ComposerMenu => serde_json::json!({"type": "composerMenu"}),
        Kind::NavItems => serde_json::json!({"type": "navItems"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(key: &str) -> &'static Def {
        DEFINITIONS.iter().find(|d| d.key == key).unwrap()
    }

    #[test]
    fn keys_are_unique() {
        let mut keys: Vec<&str> = DEFINITIONS.iter().map(|d| d.key).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before);
    }

    #[test]
    fn every_default_is_valid_for_its_own_kind() {
        for d in DEFINITIONS {
            assert_eq!(
                normalize_value(d, Some(&d.default.to_value())),
                d.default.to_value(),
                "default of {} must be accepted",
                d.key
            );
        }
    }

    #[test]
    fn device_defaults_match_the_gui_defaults() {
        let defaults = device_defaults();
        assert_eq!(defaults["inputId"], "");
        assert_eq!(defaults["output"], Value::Null);
        assert_eq!(defaults["deviceKind"], Value::Null);
        assert_eq!(defaults["hideNavigationBar"], false);
        assert_eq!(defaults["orientation"], "auto");
        assert_eq!(defaults["pluginsDisabled"], json!([]));
        assert_eq!(defaults["pluginsDevDir"], Value::Null);
    }

    #[test]
    fn user_defaults_match_the_call_defaults() {
        // DEFAULT_CALL_SETTINGS（call/pure.ts）と同じ
        assert_eq!(def("joinMuted").default.to_value(), json!(false));
        assert_eq!(def("micVolume").default.to_value(), json!(1.0));
        assert_eq!(def("outVolume").default.to_value(), json!(1.0));
        assert_eq!(def("limiter").default.to_value(), json!(true));
        assert_eq!(def("limitDb").default.to_value(), json!(-6.0));
    }

    #[test]
    fn scopes_are_as_classified() {
        assert_eq!(def("theme").scope, Scope::User);
        assert_eq!(def("micVolume").scope, Scope::User);
        assert_eq!(def("inputId").scope, Scope::Device);
        assert_eq!(def("orientation").scope, Scope::Device);
        assert_eq!(def("server").scope, Scope::Local);
        // 入力機器・出力先は端末ごと（ユーザー共通にしてはいけない）
        assert_ne!(def("inputId").scope, Scope::User);
        assert_ne!(def("output").scope, Scope::User);
    }

    #[test]
    fn bad_values_fall_back_to_the_default() {
        let raw = json!({
            "inputId": 3,
            "hideNavigationBar": "yes",
            "orientation": "sideways",
            "deviceKind": "toaster",
            "pluginsDisabled": ["a", 1],
            "pluginsDevDir": 7,
        });
        let out = normalize_device_prefs(&raw);
        assert_eq!(out["inputId"], "");
        assert_eq!(out["hideNavigationBar"], false);
        assert_eq!(out["orientation"], "auto");
        assert_eq!(out["deviceKind"], Value::Null);
        assert_eq!(out["pluginsDisabled"], json!([]));
        assert_eq!(out["pluginsDevDir"], Value::Null);
    }

    #[test]
    fn good_values_are_kept_and_unknown_keys_survive() {
        let raw = json!({
            "inputId": "mic-1",
            "output": {"id": "spk", "kind": "speaker", "label": "Speaker"},
            "deviceKind": "tablet",
            "orientation": "media",
            "pluginsDisabled": ["dice"],
            "pluginsDevDir": "/home/a/plugins",
            "futureKey": {"keep": true},
        });
        let out = normalize_device_prefs(&raw);
        assert_eq!(out["inputId"], "mic-1");
        assert_eq!(out["output"]["id"], "spk");
        assert_eq!(out["deviceKind"], "tablet");
        assert_eq!(out["orientation"], "media");
        assert_eq!(out["pluginsDisabled"], json!(["dice"]));
        assert_eq!(out["pluginsDevDir"], "/home/a/plugins");
        assert_eq!(
            out["futureKey"],
            json!({"keep": true}),
            "unknown keys are kept"
        );
    }

    #[test]
    fn numbers_are_clamped_and_non_numbers_use_the_default() {
        let user = def("limitDb");
        assert_eq!(normalize_value(user, Some(&json!(-30))), json!(-18.0));
        assert_eq!(normalize_value(user, Some(&json!(0))), json!(-3.0));
        assert_eq!(normalize_value(user, Some(&json!("loud"))), json!(-6.0));
        let mic = def("micVolume");
        assert_eq!(normalize_value(mic, Some(&json!(9))), json!(2.0));
    }

    #[test]
    fn non_object_device_prefs_become_all_defaults() {
        for raw in [json!(null), json!([1]), json!("x"), json!(3)] {
            let out = normalize_device_prefs(&raw);
            assert_eq!(out, device_defaults(), "input {raw}");
        }
    }

    #[test]
    fn definitions_json_lists_every_key_once() {
        let v = definitions_json();
        let items = v.as_array().unwrap();
        assert_eq!(items.len(), DEFINITIONS.len());
        assert!(
            items
                .iter()
                .any(|d| d["key"] == "orientation" && d["scope"] == "device")
        );
        assert!(
            items
                .iter()
                .any(|d| d["key"] == "server" && d["scope"] == "local")
        );
    }
}
