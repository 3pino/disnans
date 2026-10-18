//! ユーザー共通の設定（prefs）の読み方を、fixture で確かめる（V5）。
//! 同じ fixture を `app/src/lib/prefsFixtures.test.ts`（TS の normalize*）も読む。両方が通れば、読み方は揃っている。

use disnans_client_core::view::settings::{find_definition, normalize_value};
use serde_json::Value;

fn load() -> Value {
    let path = format!(
        "{}/tests/fixtures/prefs/user_prefs.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn user_prefs_read_like_the_gui_normalizers() {
    let file = load();
    let cases = file["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    for case in cases {
        let key = case["key"].as_str().unwrap();
        let name = case["name"].as_str().unwrap();
        let def = find_definition(key).unwrap_or_else(|| panic!("no definition for {key}"));
        let input = &case["input"];
        let actual = normalize_value(def, Some(input));
        if actual != case["expected"] {
            failures.push(format!(
                "{key} / {name}: input {input} -> {actual}, expected {}",
                case["expected"]
            ));
        }
    }
    assert!(failures.is_empty(), "failed:\n{}", failures.join("\n"));
}

#[test]
fn user_pref_definitions_are_user_scoped() {
    use disnans_client_core::view::settings::{DEFINITIONS, Scope};
    for key in [
        "hotkeys",
        "slashNames",
        "enterKeys",
        "composerMenu",
        "messageLayout",
    ] {
        let def = DEFINITIONS
            .iter()
            .find(|d| d.key == key)
            .unwrap_or_else(|| panic!("{key}"));
        assert_eq!(def.scope, Scope::User, "{key}");
    }
}

#[test]
fn defaults_match_the_fixture() {
    use disnans_client_core::view::settings::{default_of, find_definition};
    let path = format!(
        "{}/tests/fixtures/prefs/defaults.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap();
    let file: Value = serde_json::from_str(&text).unwrap();
    let defaults = file["defaults"].as_object().unwrap();
    let mut failures = Vec::new();
    for (key, expected) in defaults {
        let def = find_definition(key).unwrap_or_else(|| panic!("no definition for {key}"));
        if default_of(def) != *expected {
            failures.push(format!("{key}: {} != {expected}", default_of(def)));
        }
    }
    assert!(
        failures.is_empty(),
        "defaults differ:\n{}",
        failures.join("\n")
    );
    // 定義は fixture の全項目を覆う（足し忘れ・消し忘れの検出）
    for def in disnans_client_core::view::settings::DEFINITIONS {
        assert!(
            defaults.contains_key(def.key),
            "{} is not in defaults.json",
            def.key
        );
    }
}
