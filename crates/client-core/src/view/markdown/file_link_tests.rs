
use super::*;
use serde_json::json;

fn file(path: &str, alias: Option<&str>, embed: bool) -> Inline {
    Inline::FileLink {
        path: path.to_owned(),
        alias: alias.map(str::to_owned),
        embed,
    }
}

fn text(t: &str) -> Inline {
    Inline::Text { text: t.to_owned() }
}

#[test]
fn markdown_style_file_link_with_alias() {
    assert_eq!(
        parse_inline("[写真](attachments/photo.png)", 0),
        vec![file("attachments/photo.png", Some("写真"), false)]
    );
}

#[test]
fn wiki_style_with_and_without_alias() {
    assert_eq!(
        parse_inline("[[attachments/photo.png|写真]]", 0),
        vec![file("attachments/photo.png", Some("写真"), false)]
    );
    assert_eq!(
        parse_inline("[[docs/a.pdf]]", 0),
        vec![file("docs/a.pdf", None, false)]
    );
}

#[test]
fn leading_bang_makes_it_an_embed() {
    assert_eq!(
        parse_inline("![写真](attachments/photo.png)", 0),
        vec![file("attachments/photo.png", Some("写真"), true)]
    );
    assert_eq!(
        parse_inline("![[attachments/photo.png]]", 0),
        vec![file("attachments/photo.png", None, true)]
    );
}

#[test]
fn path_may_contain_balanced_parentheses_and_spaces() {
    assert_eq!(
        parse_inline("[a](attachments/photo (2).png)", 0),
        vec![file("attachments/photo (2).png", Some("a"), false)]
    );
}

#[test]
fn surrounding_text_and_emphasis_are_kept() {
    assert_eq!(
        parse_inline("見て **[[attachments/x|y]]** ね", 0),
        vec![
            text("見て "),
            Inline::Bold {
                children: vec![file("attachments/x", Some("y"), false)],
            },
            text(" ね"),
        ]
    );
}

#[test]
fn http_links_and_images_stay_as_they_were() {
    assert_eq!(
        parse_inline("[x](https://a.com/p)", 0),
        vec![Inline::Link {
            href: "https://a.com/p".into(),
            text: "x".into()
        }]
    );
    // 埋め込みは共有フォルダのファイルだけ。http(s) の `![..](..)` は `!` の文字と普通のリンク
    assert_eq!(
        parse_inline("![x](https://a.com/p.png)", 0),
        vec![
            text("!"),
            Inline::Link {
                href: "https://a.com/p.png".into(),
                text: "x".into()
            },
        ]
    );
}

#[test]
fn other_schemes_absolute_and_unsafe_paths_stay_text() {
    for input in [
        "[x](javascript:alert(1))",
        "[x](mailto:a@b.c)",
        "[x](/etc/passwd)",
        "[x](../secret)",
        "[x](#top)",
        "[x]( attachments/a)",
        "[[C:/x]]",
        "[[../x]]",
        "[[]]",
        "[[attachments/x|]]",
        "[[attachments/x|a]b]]",
        "[[a|[b]]",
        "![x](javascript:alert(1))",
    ] {
        assert_eq!(parse_inline(input, 0), vec![text(input)], "{input}");
    }
}

#[test]
fn code_is_not_a_file_link() {
    assert_eq!(
        parse_inline("`[[attachments/x]]`", 0),
        vec![Inline::Code {
            text: "[[attachments/x]]".into()
        }]
    );
    let blocks = parse("```\n[[attachments/x]]\n```");
    assert_eq!(
        blocks,
        vec![Block::Code {
            lang: String::new(),
            text: "[[attachments/x]]".into()
        }]
    );
}

#[test]
fn file_link_serializes_with_its_type_and_fields() {
    assert_eq!(
        serde_json::to_value(file("docs/a.pdf", None, false)).unwrap(),
        json!({"type": "fileLink", "path": "docs/a.pdf", "alias": null, "embed": false})
    );
    assert_eq!(
        serde_json::to_value(file("attachments/p.png", Some("p"), true)).unwrap(),
        json!({"type": "fileLink", "path": "attachments/p.png", "alias": "p", "embed": true})
    );
}
