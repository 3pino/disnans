//! メッセージを表示行へ変える（折り返し・エスケープ済み）。

use disnans_shared::{Message, User};

use jiff::tz::TimeZone;

use super::sanitize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Body,
    Meta,
    /// 日付の区切り線。
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub kind: RowKind,
    /// 端末へそのまま出せる文字だけ（制御文字・双方向制御はエスケープ済み）。
    pub text: String,
    /// `text` の先頭にある「アイコン 名前」の長さ（バイト）。0 なら無し。
    pub prefix: usize,
    /// 投稿者ごとの色番号（`ACCENTS` の添字）。
    pub accent: u8,
}

pub const ACCENTS: usize = 6;
const NAME_COLUMN_MAX: usize = 10;

/// 投稿者の表示名。名前が分からなければ ID。
pub fn author_name(users: &[User], id: &str) -> String {
    users.iter().find(|user| user.id == id).map_or_else(
        || sanitize::inline(id),
        |user| sanitize::inline(&user.display_name),
    )
}

/// 名前の列幅（桁）。全員で揃えて本文の開始位置をそろえる。
fn name_column(users: &[User], width: usize) -> usize {
    let widest = users
        .iter()
        .map(|u| sanitize::display_width(&sanitize::inline(&u.display_name)))
        .max()
        .unwrap_or(4);
    widest.clamp(4, NAME_COLUMN_MAX).min((width / 3).max(1))
}

fn accent(author_id: &str) -> u8 {
    let sum = author_id.bytes().fold(0usize, |a, b| {
        a.wrapping_mul(31).wrapping_add(usize::from(b))
    });
    (sum % ACCENTS) as u8
}

fn pad_to(text: &str, cells: usize) -> String {
    let mut out = sanitize::truncate(text, cells);
    let used = sanitize::display_width(&out);
    out.push_str(&" ".repeat(cells.saturating_sub(used)));
    out
}

/// 日付の区切り線（幅いっぱい、中央に日付）。
pub fn separator_row(label: &str, width: usize) -> Row {
    let text = format!(" {label} ");
    let used = sanitize::display_width(&text);
    let fill = width.saturating_sub(used);
    let left = fill / 2;
    Row {
        kind: RowKind::Separator,
        text: format!("{}{text}{}", "─".repeat(left), "─".repeat(fill - left)),
        prefix: 0,
        accent: 0,
    }
}

/// 1メッセージ分の行。`width` は履歴の表示幅（桁）。
/// 先頭行は `アイコン 名前 本文`、続く行は本文の開始位置にそろえる。
pub fn message_rows(
    message: &Message,
    users: &[User],
    width: usize,
    _zone: Option<&TimeZone>,
) -> Vec<Row> {
    let name_w = name_column(users, width);
    let lead_w = 2 + 1 + name_w + 1;
    let width = width.max(lead_w + 1);
    let inner = width - lead_w;
    let name = author_name(users, &message.author_id);
    let icon = name.chars().next().map_or("?".to_owned(), String::from);
    let lead = format!("{} {} ", pad_to(&icon, 2), pad_to(&name, name_w));
    let accent = accent(&message.author_id);

    let mut content: Vec<(RowKind, String)> = Vec::new();
    let mut push = |kind: RowKind, text: &str| {
        for line in sanitize::wrap(text, inner) {
            content.push((kind, line));
        }
    };
    if let Some(bot) = &message.bot {
        push(
            RowKind::Meta,
            &format!("[bot: {}]", sanitize::inline(&bot.name)),
        );
    }
    if let Some(reply) = &message.reply_preview {
        let who = author_name(users, &reply.author_id);
        push(
            RowKind::Meta,
            &format!("↩ {who}: {}", sanitize::inline(&reply.body)),
        );
    } else if message.reply_to.is_some() {
        push(RowKind::Meta, "↩ 返信（元の投稿は削除済み）");
    }
    if !message.body.is_empty() {
        for line in sanitize::body_lines(&message.body) {
            push(RowKind::Body, &line);
        }
    }
    if let Some(card) = &message.card {
        push(
            RowKind::Meta,
            &format!(
                "[カード: {}] {}",
                sanitize::inline(&card.title),
                sanitize::inline(&card.text)
            ),
        );
    }
    for attachment in &message.attachments {
        push(
            RowKind::Meta,
            &format!(
                "[添付: {} ({})]",
                sanitize::inline(&attachment.file_name),
                format_size(attachment.size)
            ),
        );
    }
    let reactions: Vec<String> = message
        .reactions
        .iter()
        .filter(|reaction| !reaction.user_ids.is_empty())
        .map(|reaction| {
            format!(
                "{}{}",
                sanitize::inline(&reaction.emoji),
                reaction.user_ids.len()
            )
        })
        .collect();
    if !reactions.is_empty() {
        push(RowKind::Meta, &reactions.join("  "));
    }
    if let Some(thread) = &message.thread {
        push(
            RowKind::Meta,
            &format!("[スレッド: 返信 {} 件]", thread.reply_count),
        );
    }
    if message.edited_at.is_some() {
        push(RowKind::Meta, "(編集済み)");
    }
    if content.is_empty() {
        content.push((RowKind::Body, String::new()));
    }

    let blank = " ".repeat(lead_w);
    content
        .into_iter()
        .enumerate()
        .map(|(i, (kind, line))| {
            let first = i == 0;
            Row {
                kind,
                text: format!("{}{line}", if first { &lead } else { &blank }),
                prefix: if first { lead.len() } else { 0 },
                accent,
            }
        })
        .collect()
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
    fn first_line_has_icon_name_and_body_and_the_rest_align() {
        let users = [user("u1", "Alice")];
        let rows = message_rows(&message("m", "u1", "こんにちは\n二行目"), &users, 40, None);
        assert_eq!(rows[0].text, "A  Alice こんにちは");
        assert_eq!(rows[0].prefix, "A  Alice ".len());
        assert_eq!(rows[1].text, "         二行目");
        let rows = message_rows(&message("m", "u2", "x"), &users, 40, None);
        assert_eq!(rows[0].text, "u  u2    x");
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
        for row in message_rows(&m, &[user("u1", "名\u{1b}前")], 30, None) {
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
        );
        assert_eq!(rows.len(), 4, "{rows:?}");
        assert!(rows[0].text.ends_with("あいうえおか"), "{:?}", rows[0].text);
        assert!(rows[3].text.ends_with('x'));
        for row in &rows {
            assert!(sanitize::display_width(&row.text) <= 20, "{:?}", row.text);
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
        let rows = message_rows(&m, &[], 60, None);
        let text: Vec<&str> = rows.iter().map(|r| r.text.as_str()).collect();
        assert!(text[0].ends_with("[添付: photo.png (1.5 KB)]"), "{text:?}");
        assert!(text.iter().any(|l| l.ends_with("👍2")));
        assert!(text.iter().any(|l| l.ends_with("(編集済み)")));
        assert_eq!(text.len(), 3);
    }
}
