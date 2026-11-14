use super::*;
use serde_json::json;

fn text(t: &str) -> Inline {
    Inline::Text { text: t.to_owned() }
}

fn link(url: &str) -> Inline {
    Inline::Link {
        href: url.into(),
        text: url.into(),
    }
}

#[test]
fn basic_tags_make_the_same_nodes_as_markdown() {
    assert_eq!(
        parse_inline("<b>x</b>", 0),
        vec![Inline::Bold {
            children: vec![text("x")]
        }]
    );
    assert_eq!(
        parse_inline("<strong>x</strong><em>y</em><u>z</u>", 0),
        vec![
            Inline::Bold {
                children: vec![text("x")]
            },
            Inline::Italic {
                children: vec![text("y")]
            },
            Inline::Underline {
                children: vec![text("z")]
            },
        ]
    );
    assert_eq!(
        parse_inline("<s>a</s><del>b</del><strike>c</strike><mark>d</mark>", 0),
        vec![
            Inline::Strike {
                children: vec![text("a")]
            },
            Inline::Strike {
                children: vec![text("b")]
            },
            Inline::Strike {
                children: vec![text("c")]
            },
            Inline::Highlight {
                children: vec![text("d")]
            },
        ]
    );
    assert_eq!(
        parse_inline("<code>a **b**</code>", 0),
        vec![Inline::Code {
            text: "a **b**".into()
        }]
    );
}

#[test]
fn sub_and_sup_are_nodes_with_children() {
    assert_eq!(
        parse_inline("H<sub>2</sub>O x<sup>n</sup>", 0),
        vec![
            text("H"),
            Inline::Sub {
                children: vec![text("2")]
            },
            text("O x"),
            Inline::Sup {
                children: vec![text("n")]
            },
        ]
    );
    assert_eq!(
        serde_json::to_value(Inline::Sub {
            children: vec![text("2")]
        })
        .unwrap(),
        json!({"type": "sub", "children": [{"type": "text", "text": "2"}]})
    );
    assert_eq!(
        serde_json::to_value(Inline::Sup { children: vec![] }).unwrap(),
        json!({"type": "sup", "children": []})
    );
}

#[test]
fn tag_names_are_case_insensitive() {
    assert_eq!(
        parse_inline("<SUB>2</Sub><B>x</b>", 0),
        vec![
            Inline::Sub {
                children: vec![text("2")]
            },
            Inline::Bold {
                children: vec![text("x")]
            },
        ]
    );
}

#[test]
fn tags_nest_with_markdown_and_each_other() {
    assert_eq!(
        parse_inline("**a<sub>2</sub>**", 0),
        vec![Inline::Bold {
            children: vec![
                text("a"),
                Inline::Sub {
                    children: vec![text("2")]
                },
            ],
        }]
    );
    assert_eq!(
        parse_inline("<b>a<i>b</i></b>", 0),
        vec![Inline::Bold {
            children: vec![
                text("a"),
                Inline::Italic {
                    children: vec![text("b")]
                },
            ],
        }]
    );
}

#[test]
fn same_name_nests_by_counting() {
    assert_eq!(
        parse_inline("<b><b>x</b>y</b>", 0),
        vec![Inline::Bold {
            children: vec![
                Inline::Bold {
                    children: vec![text("x")]
                },
                text("y"),
            ],
        }]
    );
}

#[test]
fn unclosed_mismatched_empty_and_unknown_tags_stay_literal() {
    for input in [
        "<b>x",
        "<b>x</i>",
        "x</b>",
        "<b></b>",
        "<br>",
        "<script>x</script>",
        "<b class=x>y</b>",
        "<b x>y</b>",
        "<sub 2>y</sub>",
        "<bb>y</bb>",
        "a<b",
        "a < b > c",
    ] {
        assert_eq!(parse_inline(input, 0), vec![text(input)], "{input}");
    }
}

#[test]
fn escaped_tags_are_literal() {
    assert_eq!(parse_inline("\\<b>x\\</b>", 0), vec![text("<b>x</b>")]);
}

#[test]
fn mentions_still_work_next_to_tags() {
    assert_eq!(
        parse_inline("<b><@user1></b> <@u-2>", 0),
        vec![
            Inline::Bold {
                children: vec![Inline::Mention {
                    user_id: "user1".into()
                }],
            },
            text(" "),
            Inline::Mention {
                user_id: "u-2".into()
            },
        ]
    );
}

#[test]
fn code_tag_keeps_file_link_syntax_as_text() {
    assert_eq!(
        parse_inline("<code>[[attachments/x]]</code>", 0),
        vec![Inline::Code {
            text: "[[attachments/x]]".into()
        }]
    );
}

#[test]
fn deep_tag_nesting_does_not_recurse_forever() {
    let input = "<b>".repeat(40) + "x" + &"</b>".repeat(40);
    // 例外なく返る（深い入れ子は文字のままになる）
    let _ = parse_inline(&input, 0);
    let _ = parse(&input);
}

#[test]
fn bare_urls_link_and_trailing_punctuation_is_left_out() {
    assert_eq!(
        parse_inline("https://www.sample.com", 0),
        vec![link("https://www.sample.com")]
    );
    assert_eq!(
        parse_inline("(https://www.sample.com)", 0),
        vec![text("("), link("https://www.sample.com"), text(")")]
    );
    assert_eq!(
        parse_inline("https://a.com/x」。", 0),
        vec![link("https://a.com/x"), text("」。")]
    );
    assert_eq!(
        parse_inline("[https://a.com/x]", 0),
        vec![text("["), link("https://a.com/x"), text("]")]
    );
    assert_eq!(
        parse_inline("https://a.com/x_(y).", 0),
        vec![link("https://a.com/x_(y)"), text(".")]
    );
}

#[test]
fn bare_urls_inside_tags_and_code_follow_the_same_rules() {
    assert_eq!(
        parse_inline("<b>https://a.com</b>", 0),
        vec![Inline::Bold {
            children: vec![link("https://a.com")]
        }]
    );
    assert_eq!(
        parse_inline("`https://a.com`", 0),
        vec![Inline::Code {
            text: "https://a.com".into()
        }]
    );
    assert_eq!(
        parse_inline("[https://a.com](https://a.com)", 0),
        vec![Inline::Link {
            href: "https://a.com".into(),
            text: "https://a.com".into(),
        }]
    );
}
