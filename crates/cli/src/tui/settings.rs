//! 設定画面の行と、入力された値を保存する値にする規則。ページ・節・項目の並びは GUI と共通の木
//! （core の `view::ui::SETTINGS_PAGES`）から作り、TUI に出さない項目（`show.tui == false`）は飛ばす。
//! 木の `Slot` のうち TUI が描くもの（キー割り当て・このデバイス・サーバー・バージョン）は、ここで行にする。
//! 通信は `device.rs`、描画は view.rs、モーダルの操作は `ui/modal.rs`。

use disnans_client_core::view::settings::{Scope, default_of};
use disnans_client_core::view::ui::{
    Control, Item, Opt, SETTINGS_TOP, field_value, option_label, resolve_key, settings_page,
};
use serde_json::{Map, Value, json};

use super::commands::{self, Bindings, Mode, key_name, parse_keys};
use super::device::Loaded;

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

/// 設定画面のページ（木のページの ID）。
pub type Page = &'static str;

/// 画面の見出し（サブページは「設定 › 名前」）。
pub fn title(page: Page) -> String {
    match settings_page(page) {
        Some(p) if p.id == SETTINGS_TOP => p.title.to_owned(),
        Some(p) => format!("設定 › {}", p.title),
        None => "設定".into(),
    }
}

/// 保存先の項目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// 木の Field の `key`（`theme`・`enterKeys.enter` など）。
    Field(&'static str),
    /// キーの割り当て（デバイスの設定 `tuiKeys`）。
    Keys(Mode, &'static str),
    DeviceName,
    /// 下の階層のページへ入る。
    Page(Page),
    /// 変えられない（表示だけ・補足の文）。
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Editor {
    Toggle,
    /// 選択肢（画面には文言を出し、保存は値）。
    Choice(&'static [Opt]),
    /// 数。画面の値は「保存する値 × scale」。
    Number {
        min: f64,
        max: f64,
        scale: f64,
    },
    /// `j, Down` のようなキー名の並び。空は既定に戻す。
    Keys,
    Name,
    /// 選ぶとサブページへ入る。
    Open,
    /// 表示だけ（選べるが変えられない）。
    Static,
    /// 補足の文（選べない）。
    Note,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// 見出し（木の Section）。同じ見出しの行がまとまる。
    pub section: &'static str,
    pub label: String,
    pub value: String,
    /// 入力の初期値（Prompt で開くとき）。
    pub input: String,
    pub target: Target,
    pub editor: Editor,
}

impl Row {
    /// カーソルを置ける行か（補足の文は置けない）。
    pub fn selectable(&self) -> bool {
        self.editor != Editor::Note
    }

    fn new(
        section: &'static str,
        label: &str,
        value: String,
        target: Target,
        editor: Editor,
    ) -> Self {
        Self {
            section,
            label: label.to_owned(),
            input: value.clone(),
            value,
            target,
            editor,
        }
    }
}

/// prefs のほかに画面に出す情報。
#[derive(Debug, Clone, Copy)]
pub struct Info<'a> {
    pub server: &'a str,
    pub version: &'a str,
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

/// 数を短く書く（整数なら小数点なし）。
fn number(n: f64) -> String {
    let rounded = (n * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        rounded.to_string()
    }
}

/// 設定の値を持つ側（ユーザー共通かデバイスごとか）の prefs。
fn prefs_of(loaded: &Loaded, scope: Scope) -> &Value {
    match scope {
        Scope::Device => &loaded.device,
        _ => &loaded.user,
    }
}

fn field_row(
    section: &'static str,
    label: &str,
    key: &'static str,
    control: &Control,
    loaded: &Loaded,
) -> Option<Row> {
    let (def, _) = resolve_key(key)?;
    let current = field_value(prefs_of(loaded, def.scope), key)?;
    let target = Target::Field(key);
    Some(match *control {
        Control::Toggle => Row::new(section, label, show(&current), target, Editor::Toggle),
        Control::Segmented { options } | Control::Select { options } => {
            let value = match current.as_str() {
                Some(v) => option_label(options, v),
                None => show(&current),
            };
            Row::new(section, label, value, target, Editor::Choice(options))
        }
        Control::Slider {
            min,
            max,
            scale,
            unit,
            ..
        } => {
            let shown = current
                .as_f64()
                .map_or_else(|| show(&current), |n| number(n * scale));
            let mut row = Row::new(
                section,
                label,
                format!("{shown}{unit}"),
                target,
                Editor::Number { min, max, scale },
            );
            row.input = shown;
            row
        }
    })
}

/// TUI が描く Slot の行。TUI に中身の無い Slot は何も出さない。
fn slot_rows(
    section: &'static str,
    id: &str,
    loaded: &Loaded,
    bindings: &Bindings,
    info: Info<'_>,
) -> Vec<Row> {
    match id {
        "tuiKeys" => REBINDABLE
            .iter()
            .map(|(mode, command, label)| {
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
                let mut row = Row::new(
                    section,
                    label,
                    if keys.is_empty() {
                        "（なし）".into()
                    } else {
                        keys.join(", ")
                    },
                    Target::Keys(*mode, command),
                    Editor::Keys,
                );
                row.input = keys.join(", ");
                row
            })
            .collect(),
        "deviceList" => vec![Row::new(
            section,
            "このデバイスの名前",
            loaded.device_name.clone(),
            Target::DeviceName,
            Editor::Name,
        )],
        "server" => vec![Row::new(
            section,
            "サーバー",
            info.server.to_owned(),
            Target::None,
            Editor::Static,
        )],
        "version" => vec![Row::new(
            section,
            "バージョン",
            format!("v{}", info.version),
            Target::None,
            Editor::Static,
        )],
        _ => Vec::new(),
    }
}

/// ページに出す行（木の順。TUI に出さない節・項目は飛ばす）。
pub fn rows(loaded: &Loaded, bindings: &Bindings, page: Page, info: Info<'_>) -> Vec<Row> {
    let Some(page) = settings_page(page).filter(|p| p.show.tui) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for section in page.sections.iter().filter(|s| s.show.tui) {
        for item in section.items.iter().filter(|i| i.show().tui) {
            match item {
                Item::Field {
                    label,
                    key,
                    control,
                    ..
                } => out.extend(field_row(section.title, label, key, control, loaded)),
                Item::Link { label, page, .. } => out.push(Row::new(
                    section.title,
                    label,
                    "›".into(),
                    Target::Page(page),
                    Editor::Open,
                )),
                Item::Slot { id, .. } => {
                    out.extend(slot_rows(section.title, id, loaded, bindings, info));
                }
                Item::Note { text, .. } => {
                    out.push(Row::new(
                        section.title,
                        text,
                        String::new(),
                        Target::None,
                        Editor::Note,
                    ));
                }
            }
        }
    }
    out
}

/// 入力（選択肢の文言・テキスト）を、保存する内容にする。誤りは画面に出す理由を返す。
pub fn to_save(row: &Row, input: &str, loaded: &Loaded) -> Result<Save, String> {
    let input = input.trim();
    match (&row.target, &row.editor) {
        (Target::Page(_) | Target::None, _) => Err("この項目は変えられません".into()),
        (Target::DeviceName, _) => {
            if input.is_empty() || input.chars().count() > 64 {
                Err("名前は 1〜64 文字にしてください".into())
            } else {
                Ok(Save::Rename(input.to_owned()))
            }
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
        (Target::Field(key), editor) => {
            let Some((def, sub)) = resolve_key(key) else {
                return Err("この項目は変えられません".into());
            };
            let value = match editor {
                Editor::Toggle => Value::Bool(matches!(input, "オン" | "true")),
                Editor::Choice(options) => match options
                    .iter()
                    .find(|o| o.label == input || o.value == input)
                {
                    Some(o) => json!(o.value),
                    None => return Err("選択肢にない値です".into()),
                },
                Editor::Number { min, max, scale } => {
                    let n: f64 = input
                        .trim_end_matches('%')
                        .trim()
                        .parse()
                        .map_err(|_| "数を入力してください".to_owned())?;
                    if !n.is_finite() || n < *min || n > *max {
                        return Err(format!(
                            "{} から {} の間で入力してください",
                            number(*min),
                            number(*max)
                        ));
                    }
                    json!(n / scale)
                }
                _ => return Err("この項目は変えられません".into()),
            };
            let value = match sub {
                None => value,
                // オブジェクトの中の 1 項目だけを変え、ほかは今の値のまま残す。
                Some(sub) => {
                    let current = prefs_of(loaded, def.scope)
                        .get(def.key)
                        .cloned()
                        .unwrap_or_else(|| default_of(def));
                    let mut map: Map<String, Value> =
                        current.as_object().cloned().unwrap_or_default();
                    map.insert(sub.to_owned(), value);
                    Value::Object(map)
                }
            };
            Ok(pref(def.scope, def.key, value))
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

    const INFO: Info<'static> = Info {
        server: "http://100.1.2.3:8080",
        version: "0.2.40",
    };

    fn loaded() -> Loaded {
        Loaded {
            device_id: "d".into(),
            device_name: "Linux (TUI)".into(),
            user: json!({"theme": "dark", "enterKeys": {"enter": "newline", "ctrl": "send"}}),
            device: json!({}),
        }
    }

    fn page(page: Page) -> Vec<Row> {
        rows(&loaded(), &Bindings::default(), page, INFO)
    }

    #[test]
    fn the_top_page_follows_the_shared_tree_and_skips_gui_only_items() {
        let top = page(SETTINGS_TOP);
        let sections: Vec<&str> = top.iter().map(|r| r.section).fold(Vec::new(), |mut a, s| {
            if !a.contains(&s) {
                a.push(s);
            }
            a
        });
        // GUI と同じ順。プロフィール・通知・プラグインは GUI だけ
        assert_eq!(sections, ["外観", "操作", "接続", "アプリ"]);
        assert_eq!(top[0].label, "テーマ");
        assert_eq!(top[0].value, "ダーク", "選択肢は木の文言で出す");
        assert!(
            matches!(top[0].editor, Editor::Choice(o) if o.iter().any(|o| o.value == "system"))
        );
        let labels: Vec<&str> = top.iter().map(|r| r.label.as_str()).collect();
        assert!(labels.contains(&"入力欄のキー") && labels.contains(&"キー割り当て"));
        assert!(!labels.contains(&"ホットキー") && !labels.contains(&"通話"));
        let server = top.iter().find(|r| r.label == "サーバー").unwrap();
        assert_eq!(
            (server.value.as_str(), &server.editor),
            (INFO.server, &Editor::Static)
        );
        assert_eq!(top.last().unwrap().value, "v0.2.40");
    }

    #[test]
    fn sub_pages_come_from_links() {
        let enter = page("enterKeys");
        assert_eq!(enter[0].label, "Enter");
        assert_eq!(enter[0].value, "改行");
        assert_eq!(enter[2].value, "送信", "ctrl は保存済み");
        assert_eq!(enter[1].value, "改行", "shift は既定");
        assert!(!enter.last().unwrap().selectable(), "補足の文は選べない");
        let devices = page("devices");
        assert_eq!(devices[0].target, Target::DeviceName);
        let keys = page("tuiKeys");
        let next = keys
            .iter()
            .find(|r| r.target == Target::Keys(Mode::Select, commands::MESSAGE_SELECT_NEXT))
            .unwrap();
        assert_eq!(next.value, "Down, j");
        assert!(page("call").is_empty(), "GUI だけのページは出さない");
        assert_eq!(title("enterKeys"), "設定 › 入力欄のキー");
        assert_eq!(title(SETTINGS_TOP), "設定");
    }

    #[test]
    fn saving_keeps_other_enter_keys_and_validates_input() {
        let l = loaded();
        let enter = page("enterKeys");
        let shift = enter
            .iter()
            .find(|r| r.target == Target::Field("enterKeys.shift"))
            .unwrap();
        let Save::Pref { scope, key, value } = to_save(shift, "送信", &l).unwrap() else {
            panic!()
        };
        assert_eq!((scope, key.as_str()), (Scope::User, "enterKeys"));
        assert_eq!(value["shift"], "send");
        assert_eq!(value["ctrl"], "send");
        assert!(to_save(shift, "どこか", &l).is_err());
        let theme = &page(SETTINGS_TOP)[0];
        assert_eq!(
            to_save(theme, "ライト", &l).unwrap(),
            Save::Pref {
                scope: Scope::User,
                key: "theme".into(),
                value: json!("light")
            }
        );
        let name = &page("devices")[0];
        assert!(to_save(name, "  ", &l).is_err());
        assert_eq!(
            to_save(name, " 机 ", &l).unwrap(),
            Save::Rename("机".into())
        );
        let keys = page("tuiKeys");
        let react = keys
            .iter()
            .find(|r| {
                matches!(
                    r.target,
                    Target::Keys(Mode::Select, commands::MESSAGE_REACT)
                )
            })
            .unwrap();
        assert!(to_save(react, "j, bogus-key", &l).is_err());
        let Save::Pref { scope, key, value } = to_save(react, "e, Enter", &l).unwrap() else {
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
        let Save::Pref { value, .. } = to_save(react, "", &l2).unwrap() else {
            panic!()
        };
        assert!(value["select"].get(commands::MESSAGE_REACT).is_none());
        let version = page(SETTINGS_TOP).into_iter().last().unwrap();
        assert!(to_save(&version, "1", &l).is_err());
    }

    #[test]
    fn numbers_are_shown_and_saved_with_the_scale() {
        let row = field_row(
            "通話",
            "マイクの音量",
            "micVolume",
            &Control::Slider {
                min: 0.0,
                max: 200.0,
                step: 5.0,
                scale: 100.0,
                unit: "%",
            },
            &loaded(),
        )
        .unwrap();
        assert_eq!((row.value.as_str(), row.input.as_str()), ("100%", "100"));
        let Save::Pref { value, .. } = to_save(&row, "150", &loaded()).unwrap() else {
            panic!()
        };
        assert_eq!(value, json!(1.5));
        assert!(to_save(&row, "300", &loaded()).is_err());
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
