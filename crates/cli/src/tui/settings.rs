//! 設定画面の行（core の `DEFINITIONS` から作る）と、入力された値を保存する値にする規則。
//! 通信は `device.rs`、描画は view.rs、モーダルの操作は `ui/modal.rs`。

use disnans_client_core::view::settings::{Def, Kind, Scope, default_of, find_definition};
use serde_json::{Map, Value, json};

use super::commands::{self, Bindings, Mode, key_name, parse_keys};
use super::device::Loaded;

/// TUI の設定画面に出す項目（GUI にしか意味の無い項目 — 通話・ナビ・向きなど — は出さない）。
/// デバイスごとの項目は、TUI で意味のあるものがまだ定義に無い。
const USER_KEYS: &[&str] = &["theme"];
const DEVICE_KEYS: &[&str] = &[];

/// Enter 系のキーの動作（`enterKeys`）の組み合わせと選択肢。
const ENTER_COMBOS: &[(&str, &str)] = &[
    ("enter", "Enter"),
    ("shift", "Shift+Enter"),
    ("ctrl", "Ctrl+Enter"),
    ("alt", "Alt+Enter"),
];
const ENTER_ACTIONS: &[&str] = &["send", "newline", "none"];

/// 設定画面で割り当てを変えられる操作。
pub const REBINDABLE: &[(Mode, &str, &str)] = &[
    (Mode::Input, commands::SEARCH_OPEN, "検索を開く（入力欄）"),
    (
        Mode::Select,
        commands::MESSAGE_SELECT_PREV,
        "前のメッセージ",
    ),
    (
        Mode::Select,
        commands::MESSAGE_SELECT_NEXT,
        "次のメッセージ",
    ),
    (Mode::Select, commands::MESSAGE_IMAGES_PREV, "画像を左へ"),
    (Mode::Select, commands::MESSAGE_IMAGES_NEXT, "画像を右へ"),
    (
        Mode::Select,
        commands::MESSAGE_REACT,
        "絵文字でリアクション",
    ),
    (Mode::Select, commands::MESSAGE_MENU, "メニュー"),
    (Mode::Select, commands::MESSAGE_REPLY, "返信"),
    (Mode::Select, commands::SEARCH_OPEN, "検索を開く（選択中）"),
];

/// 保存先の項目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    User(&'static str),
    Device(&'static str),
    /// `enterKeys` の 1 つの組み合わせ。
    EnterKey(&'static str),
    /// キーの割り当て（デバイスの設定 `tuiKeys`）。
    Keys(Mode, &'static str),
    DeviceName,
    /// 下の階層のページへ入る。
    Page(Page),
}

/// 設定画面のページ（一覧 → サブページ。GUI の設定の構成に合わせる）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Top,
    Keys,
}

impl Page {
    pub fn title(self) -> &'static str {
        match self {
            Page::Top => "設定",
            Page::Keys => "設定 › キー割り当て",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Editor {
    Toggle,
    Choice(Vec<String>),
    Text,
    Number {
        min: f64,
        max: f64,
    },
    /// `j, Down` のようなキー名の並び。空は既定に戻す。
    Keys,
    Name,
    /// 選ぶとサブページへ入る。
    Open,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// 見出し（GUI の Section に相当）。同じ見出しの行がまとまる。
    pub section: &'static str,
    pub label: String,
    pub value: String,
    pub target: Target,
    pub editor: Editor,
}

/// 保存する内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Save {
    Pref {
        scope: Scope,
        key: String,
        value: Value,
    },
    Rename(String),
}

fn show(value: &Value) -> String {
    match value {
        Value::Null => "（未設定）".into(),
        Value::Bool(true) => "オン".into(),
        Value::Bool(false) => "オフ".into(),
        Value::String(s) if s.is_empty() => "（空）".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn def_row(def: &'static Def, section: &'static str, data: &Value) -> Option<Row> {
    let current = data
        .get(def.key)
        .cloned()
        .unwrap_or_else(|| default_of(def));
    let editor = match def.kind {
        Kind::Bool => Editor::Toggle,
        Kind::Choice { options, nullable } => {
            let mut list: Vec<String> = options.iter().map(|s| (*s).to_owned()).collect();
            if nullable {
                list.push("（未設定）".into());
            }
            Editor::Choice(list)
        }
        Kind::Number { min, max } => Editor::Number { min, max },
        Kind::Text | Kind::NullableText => Editor::Text,
        _ => return None,
    };
    let target = match def.scope {
        Scope::User => Target::User(def.key),
        _ => Target::Device(def.key),
    };
    Some(Row {
        section,
        label: label_of(def.key).to_owned(),
        value: show(&current),
        target,
        editor,
    })
}

fn label_of(key: &str) -> &str {
    match key {
        "theme" => "テーマ",
        other => other,
    }
}

/// ページに出す行。見出しは GUI に合わせ、外観 → 操作 → デバイス の順。
pub fn rows(loaded: &Loaded, bindings: &Bindings, page: Page) -> Vec<Row> {
    let mut out = Vec::new();
    if page == Page::Keys {
        for (mode, command, label) in REBINDABLE {
            let keys: Vec<String> = bindings
                .keys_for(*mode, command)
                .iter()
                .filter_map(|a| key_name(a))
                .fold(Vec::new(), |mut acc, k| {
                    if !acc.contains(&k) {
                        acc.push(k);
                    }
                    acc
                });
            out.push(Row {
                section: "キー割り当て",
                label: (*label).to_owned(),
                value: if keys.is_empty() {
                    "（なし）".into()
                } else {
                    keys.join(", ")
                },
                target: Target::Keys(*mode, command),
                editor: Editor::Keys,
            });
        }
        return out;
    }
    for key in USER_KEYS {
        if let Some(row) = find_definition(key).and_then(|d| def_row(d, "外観", &loaded.user)) {
            out.push(row);
        }
    }
    let enter = loaded.user.get("enterKeys").cloned().unwrap_or_default();
    for (combo, name) in ENTER_COMBOS {
        let value = enter.get(*combo).cloned().unwrap_or(Value::Null);
        out.push(Row {
            section: "操作",
            label: format!("{name} の動作"),
            value: show(&value),
            target: Target::EnterKey(combo),
            editor: Editor::Choice(ENTER_ACTIONS.iter().map(|s| (*s).to_owned()).collect()),
        });
    }
    out.push(Row {
        section: "操作",
        label: "キー割り当て".into(),
        value: "›".into(),
        target: Target::Page(Page::Keys),
        editor: Editor::Open,
    });
    out.push(Row {
        section: "デバイス",
        label: "名前".into(),
        value: show(&Value::String(loaded.device_name.clone())),
        target: Target::DeviceName,
        editor: Editor::Name,
    });
    for key in DEVICE_KEYS {
        if let Some(row) = find_definition(key).and_then(|d| def_row(d, "デバイス", &loaded.device))
        {
            out.push(row);
        }
    }
    out
}

/// 編集ダイアログの初期値。
pub fn initial_text(row: &Row) -> String {
    match row.editor {
        Editor::Keys if row.value == "（なし）" => String::new(),
        Editor::Text | Editor::Name | Editor::Keys | Editor::Number { .. } => row
            .value
            .trim_matches(|c| c == '（' || c == '）')
            .to_owned(),
        _ => String::new(),
    }
}

/// 入力（選択肢の文字列・テキスト）を、保存する内容にする。誤りは画面に出す理由を返す。
pub fn to_save(row: &Row, input: &str, loaded: &Loaded) -> Result<Save, String> {
    let input = input.trim();
    match (&row.target, &row.editor) {
        (Target::Page(_), _) => Err("この項目は変えられません".into()),
        (Target::DeviceName, _) => {
            if input.is_empty() || input.chars().count() > 64 {
                Err("名前は 1〜64 文字にしてください".into())
            } else {
                Ok(Save::Rename(input.to_owned()))
            }
        }
        (Target::EnterKey(combo), _) => {
            let mut map: Map<String, Value> = loaded
                .user
                .get("enterKeys")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            map.insert((*combo).to_owned(), json!(input));
            Ok(pref(Scope::User, "enterKeys", Value::Object(map)))
        }
        (Target::Keys(mode, command), _) => {
            let mode_name = commands::MODE_NAMES
                .iter()
                .find(|(_, m)| m == mode)
                .map_or("select", |(n, _)| *n);
            let mut all: Map<String, Value> = loaded
                .device
                .get("tuiKeys")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut section: Map<String, Value> = all
                .get(mode_name)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if input.is_empty() {
                section.remove(*command);
            } else {
                let names: Vec<&str> = input.split(',').map(str::trim).collect();
                if names.iter().any(|n| parse_keys(n).is_none()) {
                    return Err(
                        "読めないキー名があります（例: j, Down, Enter, Esc, Ctrl+F）".into(),
                    );
                }
                section.insert((*command).to_owned(), json!(names));
            }
            all.insert(mode_name.to_owned(), Value::Object(section));
            Ok(pref(Scope::Device, "tuiKeys", Value::Object(all)))
        }
        (Target::User(key) | Target::Device(key), editor) => {
            let scope = if matches!(row.target, Target::User(_)) {
                Scope::User
            } else {
                Scope::Device
            };
            let value = match editor {
                Editor::Toggle => Value::Bool(matches!(input, "オン" | "true")),
                Editor::Choice(_) if input == "（未設定）" => Value::Null,
                Editor::Choice(_) | Editor::Text => json!(input),
                Editor::Number { min, max } => {
                    let n: f64 = input
                        .parse()
                        .map_err(|_| "数を入力してください".to_owned())?;
                    if !n.is_finite() || n < *min || n > *max {
                        return Err(format!("{min} から {max} の間で入力してください"));
                    }
                    json!(n)
                }
                _ => return Err("この項目は変えられません".into()),
            };
            Ok(pref(scope, key, value))
        }
    }
}

fn pref(scope: Scope, key: &str, value: Value) -> Save {
    Save::Pref {
        scope,
        key: key.to_owned(),
        value,
    }
}

/// 起動時と保存後に、デバイスの設定のキー割り当てを重ねた表を作る。理由つきで飛ばした項目も返す。
pub fn bindings_from(device: &Value) -> (Bindings, Vec<String>) {
    let mut bindings = Bindings::default();
    let warnings = device
        .get("tuiKeys")
        .map(|v| bindings.apply_overrides(v))
        .unwrap_or_default();
    (bindings, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded() -> Loaded {
        Loaded {
            device_id: "d".into(),
            device_name: "Linux (TUI)".into(),
            user: json!({"theme": "dark", "enterKeys": {"enter": "newline", "ctrl": "send"}}),
            device: json!({}),
        }
    }

    #[test]
    fn rows_come_from_definitions_and_show_current_values() {
        let rows = rows(&loaded(), &Bindings::default(), Page::Top);
        assert_eq!(rows[0].label, "テーマ");
        assert_eq!(rows[0].value, "dark");
        assert!(matches!(&rows[0].editor, Editor::Choice(o) if o.contains(&"system".to_owned())));
        assert!(rows.iter().any(|r| r.target == Target::DeviceName));
        let keys_page = super::rows(&loaded(), &Bindings::default(), Page::Keys);
        let next = keys_page
            .iter()
            .find(|r| r.target == Target::Keys(Mode::Select, commands::MESSAGE_SELECT_NEXT))
            .unwrap();
        assert_eq!(next.value, "Down, j");
    }

    #[test]
    fn saving_keeps_other_enter_keys_and_validates_input() {
        let l = loaded();
        let mut r = rows(&l, &Bindings::default(), Page::Top);
        r.extend(rows(&l, &Bindings::default(), Page::Keys));
        let enter_shift = r
            .iter()
            .find(|r| r.target == Target::EnterKey("shift"))
            .unwrap();
        let Save::Pref { value, .. } = to_save(enter_shift, "send", &l).unwrap() else {
            panic!()
        };
        assert_eq!(value["shift"], "send");
        assert_eq!(value["ctrl"], "send");
        let name = r.iter().find(|r| r.target == Target::DeviceName).unwrap();
        assert!(to_save(name, "  ", &l).is_err());
        assert_eq!(
            to_save(name, " 机 ", &l).unwrap(),
            Save::Rename("机".into())
        );
        let keys = r
            .iter()
            .find(|r| {
                matches!(
                    r.target,
                    Target::Keys(Mode::Select, commands::MESSAGE_REACT)
                )
            })
            .unwrap();
        assert!(to_save(keys, "j, bogus-key", &l).is_err());
        let Save::Pref { scope, key, value } = to_save(keys, "e, Enter", &l).unwrap() else {
            panic!()
        };
        assert_eq!((scope, key.as_str()), (Scope::Device, "tuiKeys"));
        assert_eq!(
            value["select"][commands::MESSAGE_REACT],
            json!(["e", "Enter"])
        );
        // 空は既定に戻す（項目を消す）
        let mut l2 = l.clone();
        l2.device = json!({"tuiKeys": value});
        let Save::Pref { value, .. } = to_save(keys, "", &l2).unwrap() else {
            panic!()
        };
        assert!(value["select"].get(commands::MESSAGE_REACT).is_none());
    }

    #[test]
    fn key_overrides_in_device_prefs_rebuild_the_bindings() {
        let (b, w) = bindings_from(&json!({"tuiKeys": {"select": {"message.react": ["e"]}}}));
        assert!(w.is_empty());
        assert_eq!(
            b.command(
                Mode::Select,
                &super::super::input::Action::Insert('e'),
                false
            ),
            Some(commands::MESSAGE_REACT)
        );
    }
}
