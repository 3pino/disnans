//! メッセージを表示行へ変える（折り返し・エスケープ済み）。

use disnans_client_core::view::{self, Calendar};
use disnans_shared::{Message, User};

use jiff::Timestamp;
use jiff::tz::TimeZone;

use super::markdown::{self, Deco};
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
    /// ターミナルへそのまま出せる文字だけ（制御文字・双方向制御はエスケープ済み）。
    pub text: String,
    /// `text` の中の装飾の範囲（バイト位置。Markdown の強調・コードなど）。
    pub decos: Vec<(usize, usize, Deco)>,
    /// このメッセージの ID（選択の強調に使う）。日付の区切りは空。
    pub message_id: String,
    /// `text` の先頭にある「アイコン 名前」の長さ（バイト）。0 なら無し。
    pub prefix: usize,
    /// 投稿者ごとの色番号（`ACCENTS` の添字）。アバターが無いときの色。
    pub accent: u8,
    /// 投稿者の ID（アバターの平均色を引く）。
    pub author_id: String,
    /// 先頭行だけ: アバター画像の取得先（`/api/avatars/…`）。画像を出せるターミナルのときだけ。
    pub avatar: Option<String>,
    /// 画像（添付サムネイル）を出すための予約行。
    pub image: Option<ImageSlot>,
}

/// 画像の予約領域の1行分。`row` 行目（0 始まり）/ 全 `rows` 行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSlot {
    /// 取得先（`/api/files/{id}/thumb`）。
    pub key: String,
    pub row: u16,
    pub rows: u16,
    pub cols: u16,
    /// 行の左端から画像までの桁数。
    pub offset: u16,
}

/// 1行分の内容（種類, 文字, 装飾の範囲）。
pub type Content = (RowKind, String, Vec<(usize, usize, Deco)>);

const IMAGE_MAX_COLS: usize = 32;
const IMAGE_MAX_ROWS: usize = 10;

pub const ACCENTS: usize = 6;
const NAME_COLUMN_MAX: usize = 10;

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
        decos: Vec::new(),
        message_id: String::new(),
        prefix: 0,
        accent: 0,
        author_id: String::new(),
        avatar: None,
        image: None,
    }
}

/// 投稿者の名前が分からないときの表示（GUI と同じ文言）
const UNKNOWN_USER: &str = "不明なユーザー";

/// 日曜始まりの曜日の表示（`view::Day::weekday` の添字）
const WEEK: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

/// 利用者のタイムゾーンでの暦。ゾーンが無ければ UTC（timefmt と同じ扱い）
pub struct ZoneCalendar<'a> {
    pub zone: Option<&'a TimeZone>,
}

impl Calendar for ZoneCalendar<'_> {
    fn day_of(&self, timestamp_ms: i64) -> view::Day {
        let utc = TimeZone::UTC;
        let zone = self.zone.unwrap_or(&utc);
        match Timestamp::from_millisecond(timestamp_ms) {
            Ok(ts) => {
                let z = ts.to_zoned(zone.clone());
                view::Day {
                    year: i32::from(z.year()),
                    month: z.month() as u8,
                    day: z.day() as u8,
                    weekday: z.weekday().to_sunday_zero_offset() as u8,
                }
            }
            Err(_) => view::UtcCalendar.day_of(0),
        }
    }
}

/// 日付の区切りの文字（`10月12日 (月)`）
fn day_text(day: view::Day) -> String {
    format!(
        "{}月{}日 ({})",
        day.month,
        day.day,
        WEEK[usize::from(day.weekday.min(6))]
    )
}

/// 一覧の全行（日付の区切りと、各メッセージの行）。日付はゾーンで決める。
/// `messages` は古い順。続きの判定（名前を省くこと）はしない（TUI は従来どおり毎回出す）。
pub fn timeline(
    messages: &[Message],
    users: &[User],
    width: usize,
    zone: Option<&TimeZone>,
    gfx: Option<(u16, u16)>,
) -> Vec<Row> {
    let calendar = ZoneCalendar { zone };
    let ctx = view::Context::new(users, None, &calendar);
    let mut rows = Vec::new();
    let mut day: Option<view::Day> = None;
    let mut previous: Option<&Message> = None;
    for message in messages {
        let today = calendar.day_of(message.created_at);
        let new_day = day != Some(today);
        if new_day {
            rows.push(separator_row(&day_text(today), width));
            day = Some(today);
        }
        // 同じ人の続き（5 分未満・同じ日）は、名前とアイコンを省く（GUI と同じ）
        let continuation =
            !new_day && previous.is_some_and(|prev| view::is_continuation(prev, message));
        let model = view::message_rows(message, &ctx);
        rows.extend(message_rows_with(
            message,
            &model,
            users,
            width,
            gfx,
            continuation,
        ));
        previous = Some(message);
    }
    rows
}

/// 1メッセージ分の行。`width` は履歴の表示幅（桁）。
/// 先頭行は `アイコン 名前 本文`、続く行は本文の開始位置にそろえる。
pub fn message_rows(
    message: &Message,
    users: &[User],
    width: usize,
    _zone: Option<&TimeZone>,
    gfx: Option<(u16, u16)>,
) -> Vec<Row> {
    let calendar = view::UtcCalendar;
    let ctx = view::Context::new(users, None, &calendar);
    let model = view::message_rows(message, &ctx);
    message_rows_with(message, &model, users, width, gfx, false)
}

/// 表示データ（core の行）を、TUI の行（幅で折り返し、接頭辞と画像の予約を付ける）に変える。
/// `continuation` なら先頭行も名前とアイコンを省き、空白で本文の位置をそろえる。
fn message_rows_with(
    message: &Message,
    model: &[view::Row],
    users: &[User],
    width: usize,
    gfx: Option<(u16, u16)>,
    continuation: bool,
) -> Vec<Row> {
    let head = match model.first() {
        Some(view::Row::Message {
            head: Some(head), ..
        }) if !continuation => Some(head),
        _ => None,
    };
    let name_w = name_column(users, width);
    // アイコン(2桁) + 空白 + 名前 + 空白2つ。名前と本文が詰まって見えないようにする。
    let lead_w = 2 + 1 + name_w + 2;
    let width = width.max(lead_w + 1);
    let inner = width - lead_w;
    let lead = match head {
        Some(head) => {
            let name = sanitize::inline(head.name.as_deref().unwrap_or(UNKNOWN_USER));
            let icon = name.chars().next().map_or("?".to_owned(), String::from);
            format!("{} {}  ", pad_to(&icon, 2), pad_to(&name, name_w))
        }
        None => " ".repeat(lead_w),
    };
    let accent = accent(&message.author_id);
    let avatar = match (gfx, head) {
        (Some(_), Some(head)) => head.avatar.as_ref().map(|a| a.url.clone()),
        _ => None,
    };

    let mut content: Vec<Content> = Vec::new();
    // 画像の予約行（内容の行の後ろに追加する）。
    let mut images: Vec<(usize, ImageSlot)> = Vec::new();
    let push = |content: &mut Vec<Content>, kind: RowKind, text: &str| {
        for line in sanitize::wrap(text, inner) {
            content.push((kind, line, Vec::new()));
        }
    };
    let name_of = |id: &str| {
        users.iter().find(|u| u.id == id).map_or_else(
            || UNKNOWN_USER.to_owned(),
            |u| sanitize::inline(&u.display_name),
        )
    };
    let mut body_done = false;
    for row in model {
        let view::Row::Message { line, .. } = row else {
            continue;
        };
        match line {
            view::Line::Body { .. } => {
                // 本文は Markdown として一度にまとめて出す（core の行は本文の行ごとに来る）。
                if !body_done {
                    body_done = true;
                    for line in markdown::render(&message.body, &name_of) {
                        for (text, decos) in markdown::layout_line(&line, inner) {
                            content.push((RowKind::Body, text, decos));
                        }
                    }
                }
            }
            view::Line::Meta { meta } => match meta {
                view::Meta::Bot { name } => push(
                    &mut content,
                    RowKind::Meta,
                    &format!("[bot: {}]", sanitize::inline(name)),
                ),
                view::Meta::Reply {
                    author, excerpt, ..
                } => {
                    let who = author.as_deref().unwrap_or(UNKNOWN_USER);
                    push(
                        &mut content,
                        RowKind::Meta,
                        &format!("↩ {}: {}", sanitize::inline(who), sanitize::inline(excerpt)),
                    );
                }
                view::Meta::ReplyDeleted => {
                    push(&mut content, RowKind::Meta, "↩ 返信（元の投稿は削除済み）")
                }
                view::Meta::Card { title, text, .. } => push(
                    &mut content,
                    RowKind::Meta,
                    &format!(
                        "[カード: {}] {}",
                        sanitize::inline(title),
                        sanitize::inline(text)
                    ),
                ),
                view::Meta::Attachment {
                    file_name,
                    size,
                    thumb,
                    ..
                } => {
                    push(
                        &mut content,
                        RowKind::Meta,
                        &format!(
                            "[添付: {} ({})]",
                            sanitize::inline(file_name),
                            format_size(*size)
                        ),
                    );
                    if let (Some(cell), Some(thumb)) = (gfx, thumb) {
                        let (cols, rows) = image_cells(thumb.width, thumb.height, inner, cell);
                        for row in 0..rows {
                            images.push((
                                content.len(),
                                ImageSlot {
                                    key: thumb.path.clone(),
                                    row: row as u16,
                                    rows: rows as u16,
                                    cols: cols as u16,
                                    offset: lead_w as u16,
                                },
                            ));
                            content.push((RowKind::Meta, String::new(), Vec::new()));
                        }
                    }
                }
                view::Meta::Reactions { items } => {
                    // 各リアクションは「 👍 2 」（前後に空白）。背景色は view.rs が decos で付ける。
                    let mut cells: Vec<markdown::Cell> = Vec::new();
                    for r in items {
                        if !cells.is_empty() {
                            cells.push((' ', Deco::NONE));
                        }
                        let deco = Deco(if r.mine {
                            Deco::REACTION_MINE
                        } else {
                            Deco::REACTION
                        });
                        let cap = Deco(deco.0 | Deco::CAP);
                        let text = format!("{} {}", sanitize::inline(&r.emoji), r.count);
                        cells.push(('\u{e0b6}', cap));
                        cells.extend(text.chars().map(|c| (c, deco)));
                        cells.push(('\u{e0b4}', cap));
                    }
                    for line in markdown::wrap_cells(&cells, inner) {
                        content.push(markdown::cells_to_content(&line, RowKind::Meta));
                    }
                }
                view::Meta::Edited => push(&mut content, RowKind::Meta, "(編集済み)"),
            },
        }
    }
    if content.is_empty() {
        content.push((RowKind::Body, String::new(), Vec::new()));
    }

    let blank = " ".repeat(lead_w);
    content
        .into_iter()
        .enumerate()
        .map(|(i, (kind, line, decos))| {
            let first = i == 0;
            let shift = if first { lead.len() } else { blank.len() };
            Row {
                kind,
                text: format!("{}{line}", if first { &lead } else { &blank }),
                decos: decos
                    .into_iter()
                    .map(|(s, e, d)| (s + shift, e + shift, d))
                    .collect(),
                message_id: message.id.clone(),
                prefix: if first && head.is_some() {
                    lead.len()
                } else {
                    0
                },
                accent,
                author_id: message.author_id.clone(),
                avatar: if first { avatar.clone() } else { None },
                image: images
                    .iter()
                    .find(|(index, _)| *index == i)
                    .map(|(_, slot)| slot.clone()),
            }
        })
        .collect()
}

/// 取得先に使ってよいパスか（サーバー由来の文字列をそのまま URL に入れない）。
/// Tailscale のプロフィール画像など、サーバー外の https の絶対 URL（GUI と同じくそのまま取得する）。
pub fn is_external_avatar(url: &str) -> bool {
    url.len() <= 2048
        && url.starts_with("https://")
        && url.is_ascii()
        && !url.bytes().any(|b| b.is_ascii_control() || b == b' ')
}

/// 画像を出す桁・行数。ターミナルのセルの縦横比（`cell` はピクセル）で、元の比率に近づける。
fn image_cells(w: u32, h: u32, inner: usize, cell: (u16, u16)) -> (usize, usize) {
    let (cw, ch) = (u64::from(cell.0.max(1)), u64::from(cell.1.max(1)));
    let (w, h) = (u64::from(w), u64::from(h));
    let mut cols = inner.clamp(1, IMAGE_MAX_COLS) as u64;
    let rows_for = |cols: u64| (cols * cw * h).div_ceil(w * ch).max(1);
    let mut rows = rows_for(cols);
    if rows > IMAGE_MAX_ROWS as u64 {
        rows = IMAGE_MAX_ROWS as u64;
        cols = ((rows * ch * w) / (h * cw)).clamp(1, cols);
    }
    (cols as usize, rows as usize)
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
            reply_to: None,
            reply_preview: None,
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1_800_000_000_000,
            edited_at: None,
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
        assert!(text[0].ends_with("[添付: photo.png (1.5 KB)]"), "{text:?}");
        assert!(text.iter().any(|l| l.ends_with("\u{e0b6}👍 2\u{e0b4}")));
        assert!(text.iter().any(|l| l.ends_with("(編集済み)")));
        assert_eq!(text.len(), 3);
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
        }
    }

    #[test]
    fn image_attachments_reserve_rows_only_when_images_are_available() {
        let mut m = message("m", "u1", "見て");
        m.attachments.push(photo("A1", 800, 400));
        let none = message_rows(&m, &[], 40, None, None);
        assert!(none.iter().all(|r| r.image.is_none()));
        let rows = message_rows(&m, &[], 40, None, Some((8, 16)));
        let slots: Vec<_> = rows.iter().filter_map(|r| r.image.as_ref()).collect();
        // 幅31桁(=248px)で 2:1 → 128px = 8 行。
        assert_eq!(slots.len(), 8);
        assert_eq!(slots[0].key, "/api/files/A1/thumb");
        assert_eq!((slots[0].cols, slots[0].rows, slots[7].row), (31, 8, 7));
        // 本文・名前の行と画像の行は重ならない。
        assert!(rows[0].image.is_none());
    }

    #[test]
    fn tall_images_are_limited_and_unsafe_ids_are_not_fetched() {
        let mut m = message("m", "u1", "");
        m.attachments.push(photo("A1", 100, 1000));
        let rows = message_rows(&m, &[], 40, None, Some((8, 16)));
        let slot = rows.iter().find_map(|r| r.image.as_ref()).unwrap();
        assert_eq!(slot.rows, 10);
        assert!(slot.cols < 10);
        let mut bad = message("m", "u1", "");
        bad.attachments.push(photo("../x", 10, 10));
        assert!(
            message_rows(&bad, &[], 40, None, Some((8, 16)))
                .iter()
                .all(|r| r.image.is_none())
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
}
