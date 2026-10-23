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

fn load_named(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/prefs/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// 通話の設定（機器・ユーザー共通）の読み方。expected は削除前の TS の parseCallSettings の出力
#[test]
fn call_settings_read_like_the_old_gui_parser() {
    let file = load_named("call_settings.json");
    let cases = file["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    for case in cases {
        let key = case["key"].as_str().unwrap();
        let def = find_definition(key).unwrap_or_else(|| panic!("no definition for {key}"));
        let actual = normalize_value(def, Some(&case["input"]));
        if !same_json(&actual, &case["expected"]) {
            failures.push(format!(
                "{key} / {}: got {actual}, expected {}",
                case["name"], case["expected"]
            ));
        }
    }
    assert!(failures.is_empty(), "failed:\n{}", failures.join("\n"));
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
        if !same_json(&default_of(def), expected) {
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

/// JSON の値が同じか。数は整数・小数の書き方を区別しない（TS の 1 と Rust の 1.0 を同じとみなす）。
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
        }
        _ => a == b,
    }
}
