//! 補完の規則の fixture（`tests/fixtures/suggest/*.json`）を、core の `view::suggest` が通すことを確かめる（batch 7）。
//! 同じ fixture を `app/src/lib/suggest/fixtures.test.ts`（GUI）も読む。両方が通れば、GUI と core（TUI）の規則は揃っている。

use disnans_client_core::view::suggest::{Kind, detect};
use disnans_shared::User;
use serde_json::{Value, json};

const FILES: &[&str] = &["mention.json", "emoji.json", "slash.json", "order.json"];

fn load(name: &str) -> Value {
    let path = format!(
        "{}/tests/fixtures/suggest/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn user(m: &Value) -> User {
    User {
        id: m["id"].as_str().unwrap().to_owned(),
        login_name: m["login_name"].as_str().unwrap().to_owned(),
        display_name: m["display_name"].as_str().unwrap().to_owned(),
        avatar_url: None,
        created_at: 0,
    }
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Mention => "mention",
        Kind::Emoji => "emoji",
        Kind::Slash => "slash",
    }
}

#[test]
fn suggest_fixtures_match_the_gui_rules() {
    let mut failures = Vec::new();
    for file in FILES {
        let f = load(file);
        let members: Vec<User> = f["members"]
            .as_array()
            .map_or(Vec::new(), |a| a.iter().map(user).collect());
        let commands: Vec<(String, String)> = f["commands"].as_array().map_or(Vec::new(), |a| {
            a.iter()
                .map(|c| {
                    (
                        c["name"].as_str().unwrap().to_owned(),
                        c["description"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        });
        let commands: Vec<(&str, &str)> = commands
            .iter()
            .map(|(n, d)| (n.as_str(), d.as_str()))
            .collect();
        for case in f["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let before = case["before"].as_str().unwrap();
            let got = match detect(before, &members, &commands) {
                None => Value::Null,
                Some(s) => {
                    // 置き換える部分は、キャレットより前の末尾の文字列（GUI の replaced と同じ）
                    let n = before.chars().count();
                    let replaced: String = before.chars().skip(n - s.chars).collect();
                    let items: Vec<Value> = s
                        .items
                        .iter()
                        .map(|c| json!({ "key": c.key, "title": c.title, "insert": c.insert }))
                        .collect();
                    json!({ "kind": kind_name(s.kind), "replaced": replaced, "query": s.query, "items": items })
                }
            };
            if got != case["expected"] {
                failures.push(format!(
                    "{file} {name}: got {got}, expected {}",
                    case["expected"]
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} case(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
