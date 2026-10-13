//! メッセージを表示行へ変える（折り返し・エスケープ済み）。

use disnans_shared::{Message, User};

use super::sanitize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Header,
    Body,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub kind: RowKind,
    /// 端末へそのまま出せる文字だけ（制御文字・双方向制御はエスケープ済み）。
    pub text: String,
}

const INDENT: &str = "  ";

/// 投稿者の表示名。名前が分からなければ ID。
pub fn author_name(users: &[User], id: &str) -> String {
    users.iter().find(|user| user.id == id).map_or_else(
        || sanitize::inline(id),
        |user| sanitize::inline(&user.display_name),
    )
}

/// 1メッセージ分の行。`width` は履歴の表示幅（桁）。
pub fn message_rows(
    message: &Message,
    users: &[User],
    width: usize,
    utc_offset_secs: i32,
) -> Vec<Row> {
    let width = width.max(INDENT.len() + 1);
    let mut rows = Vec::new();
    // 現地時刻を求められていない（オフセット 0）ときは UTC と分かるよう Z を付ける。
    let zone = if utc_offset_secs == 0 { "Z" } else { "" };
    let mut header = format!(
        "{}{zone} {}",
        format_time(message.created_at, utc_offset_secs),
        author_name(users, &message.author_id)
    );
    if let Some(bot) = &message.bot {
        header.push_str(&format!(" [bot: {}]", sanitize::inline(&bot.name)));
    }
    if message.edited_at.is_some() {
        header.push_str(" (編集済み)");
    }
    push_wrapped(&mut rows, RowKind::Header, "", &header, width);

    if let Some(reply) = &message.reply_preview {
        let who = author_name(users, &reply.author_id);
        let text = format!("↩ {who}: {}", sanitize::inline(&reply.body));
        push_wrapped(&mut rows, RowKind::Meta, INDENT, &text, width);
    } else if message.reply_to.is_some() {
        push_wrapped(
            &mut rows,
            RowKind::Meta,
            INDENT,
            "↩ 返信（元の投稿は削除済み）",
            width,
        );
    }

    if !message.body.is_empty() {
        for line in sanitize::body_lines(&message.body) {
            push_wrapped(&mut rows, RowKind::Body, INDENT, &line, width);
        }
    }
    if let Some(card) = &message.card {
        let text = format!(
            "[カード: {}] {}",
            sanitize::inline(&card.title),
            sanitize::inline(&card.text)
        );
        push_wrapped(&mut rows, RowKind::Meta, INDENT, &text, width);
    }
    for attachment in &message.attachments {
        let text = format!(
            "[添付: {} ({})]",
            sanitize::inline(&attachment.file_name),
            format_size(attachment.size)
        );
        push_wrapped(&mut rows, RowKind::Meta, INDENT, &text, width);
    }
    let reactions: Vec<String> = message
        .reactions
        .iter()
        .filter(|reaction| !reaction.user_ids.is_empty())
        .map(|reaction| {
            format!(
                "{} {}",
                sanitize::inline(&reaction.emoji),
                reaction.user_ids.len()
            )
        })
        .collect();
    if !reactions.is_empty() {
        push_wrapped(
            &mut rows,
            RowKind::Meta,
            INDENT,
            &reactions.join("  "),
            width,
        );
    }
    if let Some(thread) = &message.thread {
        let text = format!("[スレッド: 返信 {} 件]", thread.reply_count);
        push_wrapped(&mut rows, RowKind::Meta, INDENT, &text, width);
    }
    rows
}

fn push_wrapped(rows: &mut Vec<Row>, kind: RowKind, indent: &str, text: &str, width: usize) {
    let inner = width.saturating_sub(indent.len()).max(1);
    for line in sanitize::wrap(text, inner) {
        rows.push(Row {
            kind,
            text: format!("{indent}{line}"),
        });
    }
}

fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// ミリ秒の UNIX 時刻を `MM-DD HH:MM` にする。`utc_offset_secs` は UTC からのずれ。
pub fn format_time(timestamp_ms: i64, utc_offset_secs: i32) -> String {
    let secs = timestamp_ms.div_euclid(1000) + i64::from(utc_offset_secs);
    let days = secs.div_euclid(86_400);
    let in_day = secs.rem_euclid(86_400);
    let (_, month, day) = civil_from_days(days);
    format!(
        "{month:02}-{day:02} {:02}:{:02}",
        in_day / 3600,
        in_day % 3600 / 60
    )
}

/// 1970-01-01 からの日数を（年, 月, 日）へ（Howard Hinnant の algorithm）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
pub mod tests_support {
    use disnans_shared::{Message, User};

    pub fn user(id: &str, name: &str) -> User {
        User {
            id: id.into(),
            login_name: format!("{id}@test"),
            display_name: name.into(),
            avatar_url: None,
            created_at: 0,
        }
    }

    pub fn message(id: &str, author: &str, body: &str) -> Message {
        Message {
            id: id.into(),
            author_id: author.into(),
            thread_id: None,
            reply_to: None,
            reply_preview: None,
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1_800_000_000_000,
            edited_at: None,
            thread: None,
            card: None,
            bot: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{message, user};
    use super::*;
    use disnans_shared::{Attachment, BotInfo, MessageCard, Reaction, ReplyPreview};

    #[test]
    fn formats_utc_and_offset_times() {
        assert_eq!(format_time(0, 0), "01-01 00:00");
        assert_eq!(format_time(1_800_000_000_000, 0), "01-15 08:00");
        assert_eq!(format_time(1_800_000_000_000, 9 * 3600), "01-15 17:00");
        // 閏日・負の時刻。
        assert_eq!(format_time(951_782_400_000, 0), "02-29 00:00");
        assert_eq!(format_time(-1000, 0), "12-31 23:59");
    }

    #[test]
    fn header_uses_user_name_and_falls_back_to_the_id() {
        let users = [user("u1", "Alice")];
        let rows = message_rows(&message("m", "u1", "こんにちは"), &users, 40, 0);
        assert_eq!(rows[0].kind, RowKind::Header);
        assert_eq!(rows[0].text, "01-15 08:00Z Alice");
        assert_eq!(rows[1].text, "  こんにちは");
        let rows = message_rows(&message("m", "u2", "x"), &users, 40, 0);
        assert_eq!(rows[0].text, "01-15 08:00Z u2");
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
        for row in message_rows(&m, &[user("u1", "名\u{1b}前")], 30, 0) {
            assert!(!row.text.chars().any(char::is_control), "{:?}", row.text);
        }
    }

    #[test]
    fn multiline_bodies_keep_line_breaks_and_wrap_by_width() {
        let rows = message_rows(&message("m", "u", "あいうえお\n\nx"), &[], 8, 0);
        let body: Vec<&str> = rows
            .iter()
            .filter(|r| r.kind == RowKind::Body)
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(body, ["  あいう", "  えお", "  ", "  x"]);
        for row in &rows {
            assert!(sanitize::display_width(&row.text) <= 8, "{:?}", row.text);
        }
    }

    #[test]
    fn meta_lines_for_attachments_reactions_threads_and_edits() {
        let mut m = message("m", "u", "");
        m.attachments.push(Attachment {
            id: "a".into(),
            file_name: "photo.png".into(),
            mime: "image/png".into(),
            size: 1536,
            width: None,
            height: None,
            has_thumb: false,
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
        let rows = message_rows(&m, &[], 60, 0);
        let text: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(text[0], "01-15 08:00Z u (編集済み)");
        assert!(text.contains(&"  [添付: photo.png (1.5 KB)]"));
        assert!(text.contains(&"  👍 2"));
        assert_eq!(text.len(), 3);
    }
}
