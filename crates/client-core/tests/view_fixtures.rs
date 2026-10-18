//! 表示データの fixture（`tests/fixtures/view/*.json`）を、Rust の実装が通すことを確かめる（V3）。
//! 同じ fixture を `app/src/lib/view/fixtures.test.ts`（TS 側）も読む。両方が通れば、GUI と core は揃っている。

use disnans_client_core::view::markdown::{self, Block, Inline};
use disnans_client_core::view::{GROUP_MS, is_continuation};
use disnans_shared::Message;
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/view/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn cases(file: &Value) -> &Vec<Value> {
    file["inline"]
        .as_array()
        .or_else(|| file["blocks"].as_array())
        .or_else(|| file["cases"].as_array())
        .expect("cases")
}

/// 失敗したケースをまとめて報告する（最初の 1 件で止めない）
fn report(failures: Vec<String>) {
    assert!(
        failures.is_empty(),
        "{} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn inline_cases_match_the_typescript_tree() {
    let file = load("markdown.json");
    let mut failures = Vec::new();
    for case in file["inline"].as_array().expect("inline") {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let expected: Vec<Inline> = serde_json::from_value(case["expected"].clone()).unwrap();
        let got = markdown::parse_inline(input, 0);
        if got != expected {
            failures.push(format!(
                "inline {name}: {input:?}\n  got      {}\n  expected {}",
                json!(got),
                case["expected"]
            ));
        }
    }
    report(failures);
}

#[test]
fn block_cases_match_the_typescript_tree() {
    let file = load("markdown.json");
    let mut failures = Vec::new();
    for case in file["blocks"].as_array().expect("blocks") {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let expected: Vec<Block> = serde_json::from_value(case["expected"].clone()).unwrap();
        let got = markdown::parse(input);
        if got != expected {
            failures.push(format!(
                "block {name}: {input:?}\n  got      {}\n  expected {}",
                json!(got),
                case["expected"]
            ));
        }
    }
    report(failures);
}

#[test]
fn mentions_to_text_and_extract_match() {
    let file = load("markdown.json");
    for case in file["mentionsToText"].as_array().expect("mentionsToText") {
        let body = case["body"].as_str().unwrap();
        let names = case["names"].as_object().unwrap();
        let got = markdown::mentions_to_text(body, |id| {
            names
                .get(id)
                .and_then(Value::as_str)
                .map_or_else(|| id.to_owned(), str::to_owned)
        });
        assert_eq!(got, case["expected"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in file["extractMentions"].as_array().expect("extractMentions") {
        let got = markdown::extract_mentions(case["body"].as_str().unwrap());
        let expected: Vec<String> = serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(got, expected, "{}", case["name"]);
    }
}

/// fixture の RowLike（author_id・created_at・bot）から、最小限の Message を作る
fn message_from(row: &Value) -> Message {
    serde_json::from_value(json!({
        "id": "m",
        "author_id": row["author_id"],
        "reply_to": null,
        "reply_preview": null,
        "body": "",
        "attachments": [],
        "reactions": [],
        "created_at": row["created_at"],
        "edited_at": null,
        "card": null,
        "bot": row["bot"],
    }))
    .unwrap()
}

#[test]
fn continuation_cases_match_the_typescript_rule() {
    let file = load("continuation.json");
    assert_eq!(file["groupMs"].as_i64().unwrap(), GROUP_MS);
    let mut failures = Vec::new();
    for case in cases(&file) {
        let name = case["name"].as_str().unwrap();
        let new_day = case["newDay"].as_bool().unwrap();
        let expected = case["expected"].as_bool().unwrap();
        let got = if case["prev"].is_null() {
            false
        } else {
            let prev = message_from(&case["prev"]);
            let cur = message_from(&case["cur"]);
            !new_day && is_continuation(&prev, &cur)
        };
        if got != expected {
            failures.push(format!(
                "continuation {name}: got {got}, expected {expected}"
            ));
        }
    }
    report(failures);
}

/// 壊れた入力や、記号と多バイト文字が混ざった入力で、パニックしないこと（境界の確かめ）
#[test]
fn tricky_inputs_never_panic_and_keep_the_text() {
    let inputs = [
        "",
        " ",
        "**",
        "**あ**い",
        "_あ_",
        "*日本語*",
        "`あ`",
        "[あ](https://a.example/あ)",
        "https://",
        "https://あ",
        "HTTPS://A.example/x).",
        "<@",
        "<@>",
        "<@a>",
        "<@あ>",
        "\\あ",
        "\\*",
        "~~~~",
        "==x==",
        "a__b__c",
        "__a__b",
        "> > >",
        "- - -",
        "1. 2. 3.",
        "```\n",
        "```あ\n```",
        "[a](b)",
        "[[a]](https://x.example)",
        "(((",
        ")))",
        "\u{3000}**x**\u{3000}",
        "**\u{3000}x**",
        "🙂**🙂**🙂",
        "\t\t- a\n\t\t\t- b",
    ];
    for input in inputs {
        let blocks = markdown::parse(input);
        for block in blocks {
            let _ = serde_json::to_string(&block).unwrap();
        }
        let _ = markdown::parse_inline(input, 0);
        let _ = markdown::mentions_to_text(input, |id| id.to_owned());
        let _ = markdown::extract_mentions(input);
    }
}
