use disnans_shared::{
    Attachment, BotInfo, Message, MessageCard, Reaction, ReplyPreview, ThreadInfo, User,
};

use super::*;

const DAY: i64 = 86_400_000;
/// 日（UTC）の 1 時。ここからの相対時刻で発言を作る
const T0: i64 = 20_000 * DAY + 3_600_000;

fn user(id: &str, name: &str, avatar: Option<&str>) -> User {
    User {
        id: id.into(),
        login_name: format!("{id}@github"),
        display_name: name.into(),
        avatar_url: avatar.map(str::to_owned),
        created_at: 0,
    }
}

fn msg(id: &str, author: &str, body: &str, at: i64) -> Message {
    Message {
        id: id.into(),
        author_id: author.into(),
        reply_to: None,
        reply_preview: None,
        body: body.into(),
        attachments: Vec::new(),
        reactions: Vec::new(),
        created_at: at,
        edited_at: None,
        card: None,
        bot: None,
    }
}

fn users() -> Vec<User> {
    vec![
        user("me", "わたし", Some("/api/avatars/abc_1")),
        user("bob", "Bob", Some("https://ts.example.net/bob.png")),
        user("carol", "Carol", None),
    ]
}

fn timeline_of(messages: &[Message], me: Option<&str>) -> Vec<Row> {
    let users = users();
    let cal = UtcCalendar;
    let ctx = Context::new(&users, me, &cal);
    timeline_rows(messages, &ctx)
}

fn text(s: &str) -> Segment {
    Segment::Text { text: s.into() }
}

fn body_line(row: &Row) -> Option<&Vec<Segment>> {
    match row {
        Row::Message {
            line: Line::Body { segments },
            ..
        } => Some(segments),
        _ => None,
    }
}

fn head_at(row: &Row) -> Option<&Head> {
    match row {
        Row::Message { head, .. } => head.as_ref(),
        Row::Separator { .. } => None,
    }
}

#[test]
fn a_separator_precedes_the_first_message_of_each_day() {
    let rows = timeline_of(
        &[msg("m1", "bob", "a", T0), msg("m2", "bob", "b", T0 + DAY)],
        None,
    );
    let separators: Vec<String> = rows
        .iter()
        .filter_map(|r| match r {
            Row::Separator { day } => Some(day.key()),
            _ => None,
        })
        .collect();
    assert_eq!(separators, ["2024-10-04", "2024-10-05"]);
    assert!(matches!(rows[0], Row::Separator { .. }));
}

#[test]
fn the_same_person_within_five_minutes_continues_and_has_no_head() {
    let rows = timeline_of(
        &[
            msg("m1", "bob", "first", T0),
            msg("m2", "bob", "second", T0 + GROUP_MS - 1),
        ],
        None,
    );
    let heads: Vec<bool> = rows.iter().map(|r| head_at(r).is_some()).collect();
    // 区切り・m1 の先頭（頭あり）・m2 の先頭（頭なし）
    assert_eq!(heads, [false, true, false]);
}

#[test]
fn exactly_five_minutes_does_not_continue() {
    let rows = timeline_of(
        &[
            msg("m1", "bob", "a", T0),
            msg("m2", "bob", "b", T0 + GROUP_MS),
        ],
        None,
    );
    assert!(head_at(&rows[2]).is_some());
}

#[test]
fn a_new_day_never_continues_even_within_five_minutes() {
    // 日付の境界（UTC の真夜中）をまたぐ
    let rows = timeline_of(
        &[
            msg("m1", "bob", "a", DAY - 60_000),
            msg("m2", "bob", "b", DAY + 60_000),
        ],
        None,
    );
    assert!(head_at(&rows[1]).is_some(), "{rows:?}");
    assert!(matches!(rows[2], Row::Separator { .. }));
    assert!(head_at(&rows[3]).is_some());
}

#[test]
fn a_bot_message_is_grouped_only_with_the_same_plugin_and_name() {
    let bot = |plugin: &str, name: &str| BotInfo {
        plugin: plugin.into(),
        name: name.into(),
    };
    let mut a = msg("m1", "bob", "a", T0);
    a.bot = Some(bot("poll", "投票"));
    let mut b = msg("m2", "bob", "b", T0 + 1000);
    b.bot = Some(bot("poll", "投票"));
    let mut c = msg("m3", "bob", "c", T0 + 2000);
    c.bot = Some(bot("quiz", "出題"));
    let rows = timeline_of(&[a, b, c], None);
    // 頭が付くのは、続きでない最初の行だけ（m1 と m3）
    let with_head: Vec<String> = rows
        .iter()
        .filter(|r| head_at(r).is_some())
        .filter_map(|r| match r {
            Row::Message { message_id, .. } => Some(message_id.clone()),
            Row::Separator { .. } => None,
        })
        .collect();
    assert_eq!(with_head, ["m1", "m3"]);
}

#[test]
fn the_head_of_a_bot_is_the_bot_name_and_is_never_own() {
    let mut m = msg("m1", "me", "hi", T0);
    m.bot = Some(BotInfo {
        plugin: "poll".into(),
        name: "投票".into(),
    });
    let rows = timeline_of(&[m], Some("me"));
    let head = head_at(&rows[1]).expect("head");
    assert_eq!(head.name.as_deref(), Some("投票"));
    assert_eq!(head.avatar, None);
    assert_eq!(head.bot.as_ref().map(|b| b.plugin.as_str()), Some("poll"));
    assert!(!head.own);
    // ボットの印は、本文より前のメタ行
    assert!(matches!(
        &rows[1],
        Row::Message { line: Line::Meta { meta: Meta::Bot { name } }, .. } if name == "投票"
    ));
}

#[test]
fn own_messages_are_marked_and_unknown_users_have_no_name() {
    let rows = timeline_of(
        &[
            msg("m1", "me", "mine", T0),
            msg("m2", "ghost", "?", T0 + DAY),
        ],
        Some("me"),
    );
    assert!(head_at(&rows[1]).unwrap().own);
    let ghost = head_at(&rows[3]).unwrap();
    assert_eq!(ghost.name, None);
    assert_eq!(ghost.avatar, None);
    assert!(!ghost.own);
}

#[test]
fn avatars_are_own_paths_or_external_https_only() {
    assert_eq!(
        avatar_of(Some("/api/avatars/abc_1")),
        Some(Avatar {
            kind: AvatarKind::Own,
            url: "/api/avatars/abc_1".into()
        })
    );
    assert_eq!(
        avatar_of(Some("https://ts.example.net/x.png")).map(|a| a.kind),
        Some(AvatarKind::External)
    );
    // 自前のパスでも、安全でない文字があれば使わない
    assert_eq!(avatar_of(Some("/api/avatars/a/../b")), None);
    assert_eq!(avatar_of(Some("/api/avatars/")), None);
    // http・空白・制御文字は外部として使わない
    assert_eq!(avatar_of(Some("http://a.example/x.png")), None);
    assert_eq!(avatar_of(Some("https://a.example/x y.png")), None);
    assert_eq!(avatar_of(Some("https://a.example/\u{7}.png")), None);
    assert_eq!(avatar_of(None), None);
    let long = format!("https://a.example/{}", "a".repeat(2100));
    assert_eq!(avatar_of(Some(long.as_str())), None);
}

#[test]
fn body_is_split_into_lines_with_crlf_and_cr_as_breaks() {
    let rows = timeline_of(&[msg("m1", "bob", "a\r\nb\rc\nd", T0)], None);
    let lines: Vec<String> = rows
        .iter()
        .filter_map(body_line)
        .map(|segs| {
            segs.iter()
                .map(|s| match s {
                    Segment::Text { text } => text.clone(),
                    Segment::Mention { .. } => "<mention>".into(),
                })
                .collect::<String>()
        })
        .collect();
    assert_eq!(lines, ["a", "b", "c", "d"]);
}

#[test]
fn an_empty_body_without_meta_is_one_empty_body_line() {
    let rows = timeline_of(&[msg("m1", "bob", "", T0)], None);
    assert_eq!(body_line(&rows[1]), Some(&Vec::new()));
    assert_eq!(rows.len(), 2);
}

#[test]
fn mentions_resolve_to_names_and_mark_me_and_keep_unknown_or_bad_ids_as_text() {
    let rows = timeline_of(
        &[msg(
            "m1",
            "bob",
            "hi <@me> and <@carol> <@ghost> <@a.b> <@>",
            T0,
        )],
        Some("me"),
    );
    let segs = body_line(&rows[1]).expect("body").clone();
    assert_eq!(
        segs,
        vec![
            text("hi "),
            Segment::Mention {
                user_id: "me".into(),
                name: Some("わたし".into()),
                me: true
            },
            text(" and "),
            Segment::Mention {
                user_id: "carol".into(),
                name: Some("Carol".into()),
                me: false
            },
            text(" "),
            Segment::Mention {
                user_id: "ghost".into(),
                name: None,
                me: false
            },
            text(" <@a.b> <@>"),
        ]
    );
}

#[test]
fn a_mention_id_longer_than_64_chars_is_text() {
    let long = "x".repeat(65);
    let rows = timeline_of(&[msg("m1", "bob", &format!("<@{long}>"), T0)], None);
    assert_eq!(
        body_line(&rows[1]),
        Some(&vec![text(&format!("<@{long}>"))])
    );
}

#[test]
fn attachments_report_kind_and_a_thumb_only_when_it_is_safe_and_sized() {
    let att = |id: &str, mime: &str, thumb: bool, w: Option<u32>, h: Option<u32>| Attachment {
        id: id.into(),
        file_name: "pic.png".into(),
        mime: mime.into(),
        size: 2048,
        width: w,
        height: h,
        has_thumb: thumb,
    };
    let mut m = msg("m1", "bob", "", T0);
    m.attachments = vec![
        att("f_1", "image/png", true, Some(640), Some(480)),
        att("f_2", "image/png", false, Some(640), Some(480)),
        att("../x", "image/png", true, Some(640), Some(480)),
        att("f_3", "image/png", true, Some(0), Some(480)),
        att("f_4", "application/pdf", true, Some(640), Some(480)),
    ];
    let rows = timeline_of(&[m], None);
    let metas: Vec<&Meta> = rows
        .iter()
        .filter_map(|r| match r {
            Row::Message {
                line: Line::Meta { meta },
                ..
            } => Some(meta),
            _ => None,
        })
        .collect();
    let thumbs: Vec<Option<&Thumb>> = metas
        .iter()
        .map(|m| match m {
            Meta::Attachment { thumb, .. } => thumb.as_ref(),
            _ => None,
        })
        .collect();
    assert_eq!(
        thumbs[0],
        Some(&Thumb {
            path: "/api/files/f_1/thumb".into(),
            width: 640,
            height: 480
        })
    );
    assert!(thumbs[1].is_none() && thumbs[2].is_none() && thumbs[3].is_none());
    assert!(thumbs[4].is_none(), "a pdf has no image thumb");
    assert!(matches!(
        metas[4],
        Meta::Attachment {
            kind: AttachmentKind::File,
            ..
        }
    ));
    assert!(matches!(
        metas[0],
        Meta::Attachment {
            kind: AttachmentKind::Image,
            size: 2048,
            ..
        }
    ));
}

#[test]
fn reactions_skip_empty_ones_and_count_and_mark_mine() {
    let mut m = msg("m1", "bob", "", T0);
    m.reactions = vec![
        Reaction {
            emoji: "👍".into(),
            user_ids: vec!["me".into(), "carol".into()],
        },
        Reaction {
            emoji: "🎉".into(),
            user_ids: Vec::new(),
        },
        Reaction {
            emoji: "👀".into(),
            user_ids: vec!["carol".into()],
        },
    ];
    let rows = timeline_of(&[m], Some("me"));
    let items = rows
        .iter()
        .find_map(|r| match r {
            Row::Message {
                line:
                    Line::Meta {
                        meta: Meta::Reactions { items },
                    },
                ..
            } => Some(items.clone()),
            _ => None,
        })
        .expect("reactions");
    assert_eq!(
        items,
        vec![
            ReactionView {
                emoji: "👍".into(),
                count: 2,
                mine: true
            },
            ReactionView {
                emoji: "👀".into(),
                count: 1,
                mine: false
            },
        ]
    );
}

#[test]
fn reply_card_and_edited_are_meta_lines_in_the_transcript_order() {
    let mut m = msg("m1", "bob", "body", T0);
    m.reply_to = Some("r0".into());
    m.reply_preview = Some(ReplyPreview {
        author_id: "carol".into(),
        body: "元の本文".into(),
        has_attachments: true,
        bot: None,
    });
    m.card = Some(MessageCard {
        session_id: "s1".into(),
        plugin: "poll".into(),
        title: "投票".into(),
        text: "3件".into(),
    });
    m.edited_at = Some(T0 + 5);
    let rows = timeline_of(&[m], None);
    let kinds: Vec<&str> = rows[1..]
        .iter()
        .map(|r| match r {
            Row::Message {
                line: Line::Meta { meta },
                ..
            } => match meta {
                Meta::Reply { .. } => "reply",
                Meta::Card { .. } => "card",
                Meta::Edited => "edited",
                _ => "other",
            },
            Row::Message {
                line: Line::Body { .. },
                ..
            } => "body",
            Row::Separator { .. } => "separator",
        })
        .collect();
    assert_eq!(kinds, ["reply", "body", "card", "edited"]);
    assert!(matches!(
        &rows[1],
        Row::Message { line: Line::Meta { meta: Meta::Reply { author: Some(a), has_attachments: true, .. } }, .. } if a == "Carol"
    ));
}

#[test]
fn a_reply_to_a_deleted_message_is_a_single_meta_line() {
    let mut m = msg("m1", "bob", "x", T0);
    m.reply_to = Some("gone".into());
    let rows = timeline_of(&[m], None);
    assert!(matches!(
        &rows[1],
        Row::Message {
            line: Line::Meta {
                meta: Meta::ReplyDeleted
            },
            ..
        }
    ));
}

#[test]
fn the_calendar_decides_the_day_and_the_grouping() {
    struct Plus9;
    impl Calendar for Plus9 {
        fn day_of(&self, ts: i64) -> Day {
            UtcCalendar.day_of(ts + 9 * 3_600_000)
        }
    }
    // UTC の 20:00 は、+9 時間では翌日の 05:00
    let users = users();
    let cal = Plus9;
    let ctx = Context::new(&users, None, &cal);
    // UTC では 2 日（23:00 と 01:00）、+9 時間では同じ日（08:00 と 10:00）
    let rows = timeline_rows(
        &[
            msg("m1", "bob", "a", DAY - 3_600_000),
            msg("m2", "bob", "b", DAY + 3_600_000),
        ],
        &ctx,
    );
    let separators = rows
        .iter()
        .filter(|r| matches!(r, Row::Separator { .. }))
        .count();
    assert_eq!(separators, 1);
    assert_eq!(
        timeline_of(
            &[
                msg("m1", "bob", "a", DAY - 3_600_000),
                msg("m2", "bob", "b", DAY + 3_600_000)
            ],
            None
        )
        .iter()
        .filter(|r| matches!(r, Row::Separator { .. }))
        .count(),
        2
    );
}

#[test]
fn the_json_shape_is_camel_case_with_type_tags() {
    let rows = timeline_of(&[msg("m1", "me", "hi <@bob>", T0)], Some("me"));
    let value = serde_json::to_value(&rows[1]).unwrap();
    assert_eq!(value["type"], "message");
    assert_eq!(value["messageId"], "m1");
    assert_eq!(value["head"]["own"], true);
    assert_eq!(value["head"]["avatar"]["kind"], "own");
    assert_eq!(value["line"]["kind"], "body");
    assert_eq!(value["line"]["segments"][0]["type"], "text");
    assert_eq!(value["line"]["segments"][1]["type"], "mention");
    assert_eq!(value["line"]["segments"][1]["userId"], "bob");
    let sep = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(sep["type"], "separator");
    assert_eq!(sep["day"]["weekday"], 5);
    // 往復できる
    let back: Row = serde_json::from_value(value).unwrap();
    assert_eq!(back, rows[1]);
}

#[test]
fn the_card_plugin_and_session_are_kept_as_raw_values() {
    let mut m = msg("m1", "bob", "", T0);
    m.card = Some(MessageCard {
        session_id: "s\u{1b}".into(),
        plugin: "p".into(),
        title: "t\u{202e}".into(),
        text: "x".into(),
    });
    let rows = timeline_of(&[m], None);
    assert!(
        matches!(
            &rows[1],
            Row::Message { line: Line::Meta { meta: Meta::Card { session_id, title, .. } }, .. }
                if session_id == "s\u{1b}" && title == "t\u{202e}"
        ),
        "raw values are returned; escaping is the UI's job"
    );
}
