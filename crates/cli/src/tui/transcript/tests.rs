
use super::tests_support::{message, user};
use super::*;

#[test]
fn embedded_images_reserve_rows_by_state_and_only_on_graphics_terminals() {
    let users = [user("u1", "Alice")];
    let m = message("m", "u1", "見て ![[pics/a.png]]");
    let with = |gfx, state: Embed| {
        let embed = move |_: &str| state;
        let media = Media {
            embed: &embed,
            first: &|_| 0,
        };
        message_rows_for(&m, &users, 60, None, gfx, None, &media)
    };
    let plain = with(None, Embed::Ready(100, 100));
    assert!(plain.iter().all(|r| r.images.is_empty()));
    assert!(plain[0].text.contains("pics/a.png"));
    // 取得中は、取得を依頼するための 1 行だけ
    let pending = with(Some((8, 16)), Embed::Pending);
    let slots: Vec<_> = pending.iter().flat_map(|r| r.images.iter()).collect();
    assert_eq!(slots.len(), 1);
    assert_eq!(slots[0].key, "shared:pics/a.png");
    // 取得済みは画像の行数ぶん
    let ready = with(Some((8, 16)), Embed::Ready(160, 160));
    let n = ready.iter().filter(|r| !r.images.is_empty()).count();
    assert!(n > 1);
    assert_eq!(ready.len(), plain.len() + n);
    // 失敗は文字のリンクのまま
    assert!(
        with(Some((8, 16)), Embed::Failed)
            .iter()
            .all(|r| r.images.is_empty())
    );
}
use disnans_shared::{Attachment, BotInfo, MessageCard, Reaction, ReplyPreview};

#[test]
fn first_line_has_icon_name_and_body_and_the_rest_align() {
    let users = [user("u1", "Alice")];
    let rows = message_rows(
        &message("m", "u1", "こんにちは\n二行目"),
        &users,
        40,
        None,
        None,
    );
    assert_eq!(rows[0].text, "A  Alice  こんにちは");
    assert_eq!(rows[0].prefix, "A  Alice  ".len());
    assert_eq!(rows[1].text, "          二行目");
    // 不明なユーザーは ID ではなく「不明なユーザー」（GUI と同じ文言。幅 5 桁に省く）
    let rows = message_rows(&message("m", "u2", "x"), &users, 40, None, None);
    assert_eq!(rows[0].text, "不 不明…  x");
}

#[test]
fn a_bot_message_shows_the_bot_name_in_the_head_and_the_bot_line() {
    let mut m = message("m", "u1", "結果");
    m.bot = Some(BotInfo {
        plugin: "poll".into(),
        name: "投票".into(),
    });
    let rows = message_rows(&m, &[user("u1", "Alice")], 40, None, None);
    // 先頭行に名前（ボットの名前）。bot の印は本文より前の行
    assert_eq!(rows[0].text, "投 投票   [bot: 投票]");
    assert_eq!(rows[1].text, "          結果");
    assert_eq!(rows.len(), 2, "{rows:?}");
}

#[test]
fn mentions_show_the_name_or_the_unknown_user_wording() {
    let users = [user("u1", "Alice")];
    let rows = message_rows(
        &message("m", "u1", "やあ <@u1> と <@ghost>"),
        &users,
        60,
        None,
        None,
    );
    assert_eq!(rows[0].text, "A  Alice  やあ @Alice と @不明なユーザー");
}

#[test]
fn timeline_puts_one_separator_per_day_in_the_zone_and_labels_it() {
    let mut a = message("a", "u1", "x");
    a.created_at = 1_800_000_000_000;
    let mut b = message("b", "u1", "y");
    b.created_at = 1_800_000_000_000 + 3_600_000 * 24;
    let rows = timeline(&[a, b], &[user("u1", "Alice")], 40, None, None);
    let separators: Vec<&str> = rows
        .iter()
        .filter(|r| r.kind == RowKind::Separator)
        .map(|r| r.text.trim_matches('─').trim())
        .collect();
    // 2027-01-15 08:00 UTC（金）と翌日
    assert_eq!(separators, ["1月15日 (金)", "1月16日 (土)"]);
}

#[test]
fn a_continued_message_drops_the_name_and_keeps_the_text_column() {
    let users = [user("u1", "Alice")];
    let a = message("a", "u1", "one");
    let mut b = message("b", "u1", "two");
    b.created_at = a.created_at + 60_000;
    let mut c = message("c", "u2", "three");
    c.created_at = a.created_at + 120_000;
    let rows = timeline(&[a, b, c], &users, 40, None, None);
    // 区切り・1 件目（名前あり）・2 件目（同じ人の続きなので名前なし）・別の人（名前あり）
    assert_eq!(rows[1].text, "A  Alice  one");
    assert_eq!(rows[2].text, "          two");
    assert_eq!(rows[2].prefix, 0);
    assert_eq!(rows[3].text, "不 不明…  three");
}

#[test]
fn separator_is_centered_and_full_width() {
    let row = separator_row("10月12日 (月)", 30);
    assert_eq!(sanitize::display_width(&row.text), 30);
    assert!(row.text.starts_with('─') && row.text.contains("10月12日 (月)"));
}

#[test]
fn server_supplied_text_is_escaped_in_every_field() {
    let mut m = message("m\u{1b}", "u\u{1b}[31m", "本文\u{1b}[2J\n二行\u{202e}目");
    m.bot = Some(BotInfo {
        plugin: "p".into(),
        name: "b\u{9b}".into(),
    });
    m.attachments.push(Attachment {
        id: "a".into(),
        file_name: "f\u{1b}.png".into(),
        mime: "image/png".into(),
        size: 2048,
        width: None,
        height: None,
        has_thumb: false,
        deleted: false,
    });
    m.card = Some(MessageCard {
        session_id: "s".into(),
        plugin: "p".into(),
        title: "t\u{7}".into(),
        text: "x\ry".into(),
    });
    m.reactions.push(Reaction {
        emoji: "\u{200b}".into(),
        user_ids: vec!["u".into()],
    });
    m.reply_to = Some("r".into());
    m.reply_preview = Some(ReplyPreview {
        author_id: "a\u{1b}".into(),
        body: "p\u{1b}".into(),
        has_attachments: false,
        bot: None,
    });
    m.edited_at = Some(1);
    for row in message_rows(&m, &[user("u1", "名\u{1b}前")], 30, None, None) {
        assert!(!row.text.chars().any(char::is_control), "{:?}", row.text);
    }
}

#[test]
fn multiline_bodies_keep_line_breaks_and_wrap_by_width() {
    let rows = message_rows(
        &message("m", "u", "あいうえおかきくけこ\n\nx"),
        &[],
        20,
        None,
        None,
    );
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!(rows[0].text.ends_with("あいうえお"), "{:?}", rows[0].text);
    assert!(rows[2].text.ends_with('x'));
    for row in &rows {
        assert!(sanitize::display_width(&row.text) <= 20, "{:?}", row.text);
    }
}

#[test]
fn meta_lines_for_attachments_reactions_and_edits() {
    let mut m = message("m", "u", "");
    m.attachments.push(Attachment {
        id: "a".into(),
        file_name: "photo.png".into(),
        mime: "image/png".into(),
        size: 1536,
        width: None,
        height: None,
        has_thumb: false,
        deleted: false,
    });
    m.reactions.push(Reaction {
        emoji: "👍".into(),
        user_ids: vec!["a".into(), "b".into()],
    });
    m.reactions.push(Reaction {
        emoji: "x".into(),
        user_ids: vec![],
    });
    m.edited_at = Some(2);
    let rows = message_rows(&m, &[], 60, None, None);
    let text: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
    assert!(text[0].ends_with("[添付: photo.png]"), "{text:?}");
    assert!(text.iter().any(|l| l.ends_with("\u{e0b6}👍 2\u{e0b4}")));
    assert!(text.iter().any(|l| l.ends_with("(編集済み)")));
    assert_eq!(text.len(), 3);
}

#[test]
fn attachment_linked_in_the_body_is_not_listed_again() {
    let mut m = message("m", "u", "![[attachments/photo.png]]");
    m.attachments.push(Attachment {
        id: "a".into(),
        file_name: "photo.png".into(),
        mime: "image/png".into(),
        size: 1,
        width: None,
        height: None,
        has_thumb: false,
        deleted: false,
    });
    let rows = message_rows(&m, &[], 60, None, None);
    assert!(rows.iter().all(|r| !r.text.contains("[添付:")), "{rows:?}");
}

fn photo(id: &str, w: u32, h: u32) -> Attachment {
    Attachment {
        id: id.into(),
        file_name: "p.webp".into(),
        mime: "image/webp".into(),
        size: 10,
        width: Some(w),
        height: Some(h),
        has_thumb: true,
        deleted: false,
    }
}

#[test]
fn image_attachments_reserve_rows_only_when_images_are_available() {
    let mut m = message("m", "u1", "見て");
    m.attachments.push(photo("A1", 800, 400));
    let none = message_rows(&m, &[], 40, None, None);
    assert!(none.iter().all(|r| r.images.is_empty()));
    let rows = message_rows(&m, &[], 40, None, Some((8, 16)));
    let slots: Vec<_> = rows.iter().flat_map(|r| r.images.iter()).collect();
    // 幅31桁(=248px)で 2:1 → 128px = 8 行。
    assert_eq!(slots.len(), 8);
    assert_eq!(slots[0].key, "/api/files/A1/thumb");
    assert_eq!((slots[0].cols, slots[0].rows, slots[7].row), (31, 8, 7));
    // 本文・名前の行と画像の行は重ならない。
    assert!(rows[0].images.is_empty());
}

#[test]
fn many_images_line_up_horizontally_and_scroll_by_whole_images() {
    let mut m = message("m", "u1", "");
    for id in ["A1", "A2", "A3", "A4", "A5"] {
        m.attachments.push(photo(id, 160, 160));
    }
    let rows_at = |first: usize| {
        let first_fn = move |_: &str| first;
        let media = Media {
            embed: &|_| Embed::Failed,
            first: &first_fn,
        };
        message_rows_for(&m, &[], 80, None, Some((8, 16)), None, &media)
    };
    // 本文の幅は 71 桁。正方形は 10 行 × 20 桁(8x16 のセル)で 3 枚入る。
    let rows = rows_at(0);
    let strip = rows.iter().find_map(|r| r.strip).unwrap();
    assert_eq!((strip.first, strip.end, strip.total), (0, 3, 5));
    let keys: Vec<_> = rows
        .iter()
        .flat_map(|r| r.images.iter())
        .filter(|s| s.row == 0)
        .map(|s| (s.key.as_str(), s.offset))
        .collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(keys[0].0, "/api/files/A1/thumb");
    assert!(keys[1].1 > keys[0].1, "右へ並ぶ: {keys:?}");
    assert!(rows.iter().any(|r| r.text.contains("1–3 / 5 ›")));
    // 右へ 1 枚。左にも続きがある印が付く。
    let rows = rows_at(1);
    let strip = rows.iter().find_map(|r| r.strip).unwrap();
    assert_eq!((strip.first, strip.end), (1, 4));
    assert!(rows.iter().any(|r| r.text.contains("‹ 2–4 / 5 ›")));
    // 最後まで来たら、それ以上は進まない
    let strip = rows_at(99).iter().find_map(|r| r.strip).unwrap();
    assert_eq!((strip.first, strip.end, strip.total), (4, 5, 5));
}

#[test]
fn tall_images_are_limited_and_unsafe_ids_are_not_fetched() {
    let mut m = message("m", "u1", "");
    m.attachments.push(photo("A1", 100, 1000));
    let rows = message_rows(&m, &[], 40, None, Some((8, 16)));
    let slot = rows.iter().flat_map(|r| r.images.iter()).next().unwrap();
    assert_eq!(slot.rows, 10);
    assert!(slot.cols < 10);
    let mut bad = message("m", "u1", "");
    bad.attachments.push(photo("../x", 10, 10));
    assert!(
        message_rows(&bad, &[], 40, None, Some((8, 16)))
            .iter()
            .all(|r| r.images.is_empty())
    );
}

#[test]
fn avatar_is_requested_only_for_server_avatars_on_the_first_row() {
    let mut u = user("u1", "Alice");
    u.avatar_url = Some("/api/avatars/abc".into());
    let rows = message_rows(
        &message("m", "u1", "a\nb"),
        &[u.clone()],
        40,
        None,
        Some((8, 16)),
    );
    assert_eq!(rows[0].avatar.as_deref(), Some("/api/avatars/abc"));
    assert!(rows[1].avatar.is_none());
    u.avatar_url = Some("http://example.test/x.png".into());
    let rows = message_rows(
        &message("m", "u1", "a"),
        &[u.clone()],
        40,
        None,
        Some((8, 16)),
    );
    assert!(rows[0].avatar.is_none());
    u.avatar_url = Some("/api/avatars/abc".into());
    assert!(
        message_rows(&message("m", "u1", "a"), &[u], 40, None, None)[0]
            .avatar
            .is_none()
    );
}

#[test]
fn name_and_body_are_separated_by_two_spaces_even_when_truncated() {
    let users = [user("u1", "aosan-2580123456789")];
    let rows = message_rows(&message("m", "u1", "おはよう"), &users, 40, None, None);
    assert!(rows[0].text.contains("…  おはよう"), "{:?}", rows[0].text);
}
