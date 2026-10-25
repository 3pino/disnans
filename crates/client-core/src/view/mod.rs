//! 表示データ（ステップ8・V2a）。GUI と TUI（ターミナル）が同じ意味の行を使えるように、描画に依存しない形で作る。
//!
//! 条件（cli-tui・chief の判断）:
//! - 描画に依存しない。文字列の幅・折り返し・桁合わせは各 UI が行う。
//! - サーバー由来の文字列は **生の値のまま**返す。表示用のエスケープ（制御文字・双方向制御）は各 UI が行う。
//! - 時刻の日付（暦の日）はタイムゾーンを持つ `Calendar` が決める。文言（「今日」「昨日」など）は UI が作る。
//! - 名前が分からないユーザーは `name: None`。その表示の文言は [`UNKNOWN_USER_NAME`]（GUI は同じ値を TS の定数に持ち、fixture で一致を確かめる）。
//! - スレッドはモデルに含めない（`thread`・`thread_id` は見ない）。
//!
//! 行の列（`timeline_rows`）は、TUI の transcript と同じ並びを表す:
//! 日付の区切り → （同じ人の続きでなければ）先頭行に投稿者の頭（`head`）→ 本文の行 → メタ（bot・返信・カード・添付・リアクション・編集）。

mod calendar;
pub mod emoji;
pub mod markdown;
pub mod settings;
pub mod suggest;
pub mod ui;

use std::collections::HashMap;

use disnans_shared::{Attachment, Message, User};
use serde::{Deserialize, Serialize};

pub use calendar::{Calendar, Day, UtcCalendar};

/// この時間内の同じ人の発言は、まとめて 1 つの続きとみなす（web の GROUP_MS と同じ）
pub const GROUP_MS: i64 = 5 * 60_000;

/// 名前が分からないユーザーの表示（GUI・TUI が同じ文言を出す）。`fixtures/view/texts.json` と一致する
pub const UNKNOWN_USER_NAME: &str = "不明なユーザー";

/// 投稿者のアバター。`Own` はサーバーの相対パス（`/api/avatars/…`）、`External` は https の絶対 URL（Tailscale など）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Avatar {
    pub kind: AvatarKind,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Own,
    External,
}

/// ボットとして投稿したメッセージの名前と、投稿したプラグイン（アイコンは UI がプラグイン ID で引く）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotView {
    pub name: String,
    pub plugin: String,
}

/// 行の先頭に出す投稿者の情報（同じ人の続きの行には付かない）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub author_id: String,
    /// 表示名。分からないときは `None`（UI が [`UNKNOWN_USER_NAME`] を出す）。ボットなら、ボットの名前
    pub name: Option<String>,
    pub avatar: Option<Avatar>,
    pub bot: Option<BotView>,
    /// 自分の発言か（ボットの発言は含めない）
    pub own: bool,
}

/// 本文の 1 行の部品。メンションは名前に直さず、ID と名前（分かれば）を分けて持つ
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Segment {
    Text {
        text: String,
    },
    Mention {
        user_id: String,
        /// 表示名。分からないときは `None`
        name: Option<String>,
        /// 自分へのメンションか
        me: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    File,
}

/// 添付のサムネイル（画像で、サムネイルがあり、大きさが分かるとき）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumb {
    /// サーバーの相対パス（`/api/files/{id}/thumb`）
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionView {
    pub emoji: String,
    pub count: usize,
    /// 自分が付けたか
    pub mine: bool,
}

/// 本文以外の行（メタ）。UI は種類ごとに表示を決める
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Meta {
    /// ボットの投稿であることの印（名前は `Head` にもある）
    Bot {
        name: String,
    },
    /// 返信の引用。`author` は返信先の表示名（不明なら `None`）
    Reply {
        author: Option<String>,
        excerpt: String,
        has_attachments: bool,
    },
    /// 返信先が削除されている（`reply_to` だけが残っている）
    ReplyDeleted,
    /// プラグインのセッションのカード
    Card {
        session_id: String,
        plugin: String,
        title: String,
        text: String,
    },
    Attachment {
        kind: AttachmentKind,
        id: String,
        file_name: String,
        mime: String,
        size: u64,
        thumb: Option<Thumb>,
    },
    /// 絵文字ごとの件数（0 件の絵文字は含めない）
    Reactions {
        items: Vec<ReactionView>,
    },
    Edited,
}

/// 1 行の中身
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Line {
    /// 本文の 1 行（改行で分けたもの）。空の本文は空の部品の一覧
    Body {
        segments: Vec<Segment>,
    },
    Meta {
        meta: Meta,
    },
}

/// 表示行。日付の区切りと、メッセージの行
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Row {
    /// 日付の区切り（その日の最初の発言の前に 1 つ）
    Separator { day: Day },
    /// メッセージの 1 行。`head` は、そのメッセージの先頭行だけに付く（同じ人の続きなら、どの行にも付かない）。
    /// 大きい値は箱に入れる（`Row` の変種の大きさをそろえる。JSON の形は変わらない）
    Message {
        message_id: String,
        head: Option<Box<Head>>,
        line: Line,
    },
}

/// 表示データを作るときの前提（ユーザー・自分・暦）
pub struct Context<'a> {
    users: Directory<'a>,
    me: Option<&'a str>,
    calendar: &'a dyn Calendar,
}

impl<'a> Context<'a> {
    /// `me` は自分のユーザー ID（分からなければ `None`）
    pub fn new(users: &'a [User], me: Option<&'a str>, calendar: &'a dyn Calendar) -> Self {
        Self {
            users: Directory::new(users),
            me,
            calendar,
        }
    }
}

struct Directory<'a> {
    by_id: HashMap<&'a str, &'a User>,
}

impl<'a> Directory<'a> {
    fn new(users: &'a [User]) -> Self {
        Self {
            by_id: users.iter().map(|u| (u.id.as_str(), u)).collect(),
        }
    }

    fn user(&self, id: &str) -> Option<&'a User> {
        self.by_id.get(id).copied()
    }

    fn name(&self, id: &str) -> Option<String> {
        self.user(id).map(|u| u.display_name.clone())
    }
}

/// 表示の行の並び（古い順に渡す）。TUI の一覧と GUI の一覧がこの並びを使う
pub fn timeline_rows(messages: &[Message], ctx: &Context<'_>) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut previous: Option<(&Message, Day)> = None;
    for message in messages {
        let day = ctx.calendar.day_of(message.created_at);
        let new_day = previous.is_none_or(|(_, d)| d != day);
        if new_day {
            rows.push(Row::Separator { day });
        }
        let continuation = match previous {
            Some((prev, _)) if !new_day => is_continuation(prev, message),
            _ => false,
        };
        rows.extend(rows_of(message, continuation, ctx));
        previous = Some((message, day));
    }
    rows
}

/// `cur` が `prev` の続きか（同じ人・同じボット・5 分未満。日付の変わり目は含めない）。
/// 呼び出し側が日付の区切りを判断する。スレッドの条件は持たない
pub fn is_continuation(prev: &Message, cur: &Message) -> bool {
    let bot_of = |m: &Message| m.bot.as_ref().map(|b| (b.plugin.clone(), b.name.clone()));
    prev.author_id == cur.author_id
        && bot_of(prev) == bot_of(cur)
        && cur.created_at - prev.created_at < GROUP_MS
}

/// 1 件のメッセージの行（前の発言との続きは見ない。頭は必ず先頭行に付く）。一覧は `timeline_rows` を使う
pub fn message_rows(message: &Message, ctx: &Context<'_>) -> Vec<Row> {
    rows_of(message, false, ctx)
}

/// 1 件のメッセージの行。`continuation` なら先頭行にも頭（head）を付けない
fn rows_of(message: &Message, continuation: bool, ctx: &Context<'_>) -> Vec<Row> {
    let head = head_of(message, ctx);
    let lines = message_lines(message, ctx);
    lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| Row::Message {
            message_id: message.id.clone(),
            head: if i == 0 && !continuation {
                Some(Box::new(head.clone()))
            } else {
                None
            },
            line,
        })
        .collect()
}

fn head_of(message: &Message, ctx: &Context<'_>) -> Head {
    if let Some(bot) = &message.bot {
        return Head {
            author_id: message.author_id.clone(),
            name: Some(bot.name.clone()),
            avatar: None,
            bot: Some(BotView {
                name: bot.name.clone(),
                plugin: bot.plugin.clone(),
            }),
            own: false,
        };
    }
    let user = ctx.users.user(&message.author_id);
    Head {
        author_id: message.author_id.clone(),
        name: user.map(|u| u.display_name.clone()),
        avatar: avatar_of(user.and_then(|u| u.avatar_url.as_deref())),
        bot: None,
        own: ctx.me == Some(message.author_id.as_str()),
    }
}

/// メッセージの行（TUI の transcript と同じ順: bot・返信・本文・カード・添付・リアクション・編集）
fn message_lines(message: &Message, ctx: &Context<'_>) -> Vec<Line> {
    let mut lines = Vec::new();
    if let Some(bot) = &message.bot {
        lines.push(Line::Meta {
            meta: Meta::Bot {
                name: bot.name.clone(),
            },
        });
    }
    if let Some(reply) = &message.reply_preview {
        let author = match &reply.bot {
            Some(bot) => Some(bot.name.clone()),
            None => ctx.users.name(&reply.author_id),
        };
        lines.push(Line::Meta {
            meta: Meta::Reply {
                author,
                excerpt: reply.body.clone(),
                has_attachments: reply.has_attachments,
            },
        });
    } else if message.reply_to.is_some() {
        lines.push(Line::Meta {
            meta: Meta::ReplyDeleted,
        });
    }
    for line in split_lines(&message.body) {
        lines.push(Line::Body {
            segments: segments_of(line, ctx),
        });
    }
    if let Some(card) = &message.card {
        lines.push(Line::Meta {
            meta: Meta::Card {
                session_id: card.session_id.clone(),
                plugin: card.plugin.clone(),
                title: card.title.clone(),
                text: card.text.clone(),
            },
        });
    }
    for attachment in &message.attachments {
        lines.push(Line::Meta {
            meta: attachment_meta(attachment),
        });
    }
    let reactions: Vec<ReactionView> = message
        .reactions
        .iter()
        .filter(|r| !r.user_ids.is_empty())
        .map(|r| ReactionView {
            emoji: r.emoji.clone(),
            count: r.user_ids.len(),
            mine: ctx
                .me
                .is_some_and(|me| r.user_ids.iter().any(|id| id == me)),
        })
        .collect();
    if !reactions.is_empty() {
        lines.push(Line::Meta {
            meta: Meta::Reactions { items: reactions },
        });
    }
    if message.edited_at.is_some() {
        lines.push(Line::Meta { meta: Meta::Edited });
    }
    if lines.is_empty() {
        lines.push(Line::Body {
            segments: Vec::new(),
        });
    }
    lines
}

fn attachment_meta(attachment: &Attachment) -> Meta {
    let image = attachment.mime.starts_with("image/");
    let thumb = match (
        attachment.has_thumb,
        image,
        attachment.width,
        attachment.height,
    ) {
        (true, true, Some(width), Some(height))
            if width > 0 && height > 0 && is_safe_id(&attachment.id) =>
        {
            Some(Thumb {
                path: format!("/api/files/{}/thumb", attachment.id),
                width,
                height,
            })
        }
        _ => None,
    };
    Meta::Attachment {
        kind: if image {
            AttachmentKind::Image
        } else {
            AttachmentKind::File
        },
        id: attachment.id.clone(),
        file_name: attachment.file_name.clone(),
        mime: attachment.mime.clone(),
        size: attachment.size,
        thumb,
    }
}

/// 本文の改行（CRLF・CR も LF と同じ）で分ける。空の本文は行を作らない
fn split_lines(body: &str) -> Vec<&str> {
    if body.is_empty() {
        return Vec::new();
    }
    body.split("\r\n")
        .flat_map(|part| part.split(['\r', '\n']))
        .collect()
}

/// 1 行を部品に分ける。`<@id>`（id は英数字・`_`・`-` の 1〜64 文字）だけがメンションになる
fn segments_of(line: &str, ctx: &Context<'_>) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    let bytes = line.as_bytes();
    while i + 1 < bytes.len() {
        if bytes[i] == b'<'
            && bytes[i + 1] == b'@'
            && let Some((id, end)) = mention_at(line, i)
        {
            if text_start < i {
                out.push(Segment::Text {
                    text: line[text_start..i].to_owned(),
                });
            }
            out.push(Segment::Mention {
                user_id: id.to_owned(),
                name: ctx.users.name(id),
                me: ctx.me == Some(id),
            });
            i = end;
            text_start = end;
            continue;
        }
        i += 1;
    }
    if text_start < line.len() {
        out.push(Segment::Text {
            text: line[text_start..].to_owned(),
        });
    }
    out
}

/// `<@id>` が位置 `start` から始まるなら、id と、その次の位置を返す
fn mention_at(line: &str, start: usize) -> Option<(&str, usize)> {
    let rest = &line[start + 2..];
    let len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        .count();
    if len == 0 || len > 64 || rest.as_bytes().get(len) != Some(&b'>') {
        return None;
    }
    Some((&rest[..len], start + 2 + len + 1))
}

/// アバターの URL を、自前（`/api/avatars/…`）か外部（https の絶対 URL）として分類する。どちらでもなければ `None`
pub fn avatar_of(url: Option<&str>) -> Option<Avatar> {
    let url = url?;
    if let Some(rest) = url.strip_prefix("/api/avatars/") {
        if is_safe_id(rest) {
            return Some(Avatar {
                kind: AvatarKind::Own,
                url: url.to_owned(),
            });
        }
        return None;
    }
    if is_external_url(url) {
        return Some(Avatar {
            kind: AvatarKind::External,
            url: url.to_owned(),
        });
    }
    None
}

/// 外部のアバターとして受け入れる URL（https・ASCII・空白と制御文字なし・2048 文字以下）
fn is_external_url(url: &str) -> bool {
    url.len() <= 2048
        && url.starts_with("https://")
        && url.is_ascii()
        && !url.bytes().any(|b| b.is_ascii_control() || b == b' ')
}

/// パスに入れてよい ID（英数字・`_`・`-` だけ。空は不可）
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
mod tests;
