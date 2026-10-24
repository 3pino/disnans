//! ratatui での描画。ターミナルへ渡す文字列はすべてエスケープ済みのものだけを使う。

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};

use super::app::{App, ConnState, Focus, SendState};
use super::commands::Mode;
use super::graphics::Placement;
use super::markdown::Deco;
use super::sanitize;
use super::search::Phase;
use super::transcript::{self, Row, RowKind};
use super::ui::modal::Modal;
use super::ui::theme::{self, Theme};

fn t() -> &'static Theme {
    theme::current()
}

pub const MIN_WIDTH: u16 = 20;
pub const MIN_HEIGHT: u16 = 8;
const MAX_INPUT_ROWS: usize = 5;
const BUTTON_W: u16 = 8;
const PLACEHOLDER: &str = "ここにテキストを入力";

pub fn status_text(app: &App) -> String {
    let name = app
        .me
        .as_ref()
        .map(|me| format!(" ({})", sanitize::inline(&me.display_name)))
        .unwrap_or_default();
    let conn = match &app.conn {
        ConnState::Connecting => "接続中…".to_owned(),
        ConnState::Connected { .. } => "接続済み".to_owned(),
        ConnState::Reconnecting { generation, reason } => format!(
            "切断・再接続中 (第{generation}接続の後: {})",
            sanitize::inline(reason)
        ),
        ConnState::Failed {
            reason,
            http_status,
        } => {
            let status = http_status.map_or_else(String::new, |s| format!(" HTTP {s}"));
            format!(
                "接続できません{status}: {} (Ctrl+Q で終了)",
                sanitize::inline(reason)
            )
        }
    };
    let mut text = format!("disnans{name} | {conn}");
    if app.loading_initial {
        text.push_str(" | 履歴を読み込み中…");
    } else if app.loading_older {
        text.push_str(" | 古い履歴を読み込み中…");
    } else if app.refetching {
        text.push_str(" | 再取得中…");
    }
    if app.scroll > 0 {
        text.push_str(" | 過去を表示中 (Ctrl+End で最新へ)");
    }
    text
}

/// 入力欄の上に出す1行。送信の状態・通知・履歴の取得失敗を優先順に出す。
pub fn message_line(app: &App) -> Option<(String, Color)> {
    match &app.send {
        SendState::Sending { .. } => return Some(("送信中…".into(), t().warning)),
        SendState::Unknown {
            client_id, detail, ..
        } if app.notice.is_none() => {
            return Some((
                format!(
                    "送信結果が不明です ({}): 二重投稿を避けるため再送していません (client_id: {}) \
                     `disnans messages` で確認してください",
                    sanitize::inline(detail),
                    sanitize::inline(client_id)
                ),
                t().danger,
            ));
        }
        _ => {}
    }
    if app.mode == Mode::Search {
        let s = &app.search;
        let line = match s.phase {
            Phase::Editing => format!("検索: {}▏", sanitize::inline(s.query.as_str())),
            Phase::Loading => format!("検索: {} （検索中…）", sanitize::inline(&s.last_query)),
            Phase::Browsing => {
                format!("検索: {} （/ で語を編集）", sanitize::inline(&s.last_query))
            }
            Phase::Detail => format!(
                "検索: {} （詳細・読み取り専用）",
                sanitize::inline(&s.last_query)
            ),
        };
        let text = match &s.error {
            Some(e) => format!("{line}  ⚠ {}", sanitize::inline(e)),
            None => line,
        };
        return Some((text, t().warning));
    }
    if app.mode == Mode::Select {
        return Some(("メッセージを選択中".into(), t().warning));
    }
    if let Some((title, body)) = &app.alert {
        return Some((
            format!(
                "通知: {} {}",
                sanitize::inline(title),
                sanitize::inline(body)
            ),
            t().info,
        ));
    }
    if let Some(notice) = &app.notice {
        return Some((notice.clone(), t().warning));
    }
    if let Some(id) = &app.reply_to {
        let target = app.messages.iter().find(|m| &m.id == id);
        let who = target
            .and_then(|m| app.users.iter().find(|u| u.id == m.author_id))
            .map_or("不明なユーザー", |u| u.display_name.as_str());
        let excerpt = target.map_or("", |m| m.body.as_str());
        return Some((
            format!(
                "↩ 返信先: {}: {} (Esc で取消)",
                sanitize::inline(who),
                sanitize::truncate(
                    &sanitize::inline(&crate::attach::plain_excerpt(excerpt)),
                    30
                )
            ),
            t().info,
        ));
    }
    app.history_error.clone().map(|e| (e, t().danger))
}

struct Regions {
    status: Rect,
    history: Rect,
    message: Rect,
    /// 角丸の枠（罫線を含む）。
    input: Rect,
    hint: Rect,
    navbar: Rect,
}

/// 状態バーは、接続が正常で何も待っていないときは出さない（狭い画面を履歴に使う）。
fn status_visible(app: &App) -> bool {
    !matches!(app.conn, ConnState::Connected { .. })
        || app.loading_initial
        || app.loading_older
        || app.refetching
        || app.scroll > 0
}

/// 入力欄の中の幅（枠と左右の余白を除く）。
fn input_inner_width(width: u16) -> usize {
    usize::from(width)
        .saturating_sub(usize::from(BUTTON_W) + 4)
        .max(1)
}

fn regions(area: Rect, app: &App) -> Regions {
    let status_h = u16::from(status_visible(app));
    let wanted = app
        .input
        .layout(input_inner_width(area.width))
        .0
        .len()
        .clamp(1, MAX_INPUT_ROWS);
    // 状態・履歴1・メッセージ行・枠2・案内・navbar を除いた残りまで。
    let room = usize::from(area.height.saturating_sub(status_h + 1 + 1 + 2 + 1 + 1)).max(1);
    let input_height = wanted.min(room) as u16 + 2;
    let [status, history, message, input, hint, navbar] = Layout::vertical([
        Constraint::Length(status_h),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(input_height),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);
    Regions {
        status,
        history,
        message,
        input,
        hint,
        navbar,
    }
}

/// 履歴領域の大きさ（桁・行）。ターミナルサイズの変化のたびに `App` へ伝える。
pub fn history_size(area: Rect, app: &App) -> (usize, usize) {
    let r = regions(area, app);
    (usize::from(r.history.width), usize::from(r.history.height))
}

/// 先頭の `cells` 桁ぶんの文字を空白にする（その上にアバター画像を重ねるとき）。
fn blank_first_cells(text: &str, cells: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    let mut chars = text.chars();
    for c in chars.by_ref() {
        used += sanitize::char_width(c);
        out.push(' ');
        if used >= cells {
            break;
        }
    }
    // 幅の足りない分（全角1文字で2桁を超えた場合など）はそのまま。
    out.extend(chars);
    out
}

/// Markdown の装飾をターミナルの修飾・色にする。
fn deco_style(deco: Deco, base: Style) -> Style {
    let mut style = base;
    if deco.has(Deco::BOLD) {
        style = style.add_modifier(Modifier::BOLD);
    }
    if deco.has(Deco::ITALIC) {
        style = style.add_modifier(Modifier::ITALIC);
    }
    if deco.has(Deco::UNDERLINE) {
        style = style.add_modifier(Modifier::UNDERLINED);
    }
    if deco.has(Deco::STRIKE) {
        style = style.add_modifier(Modifier::CROSSED_OUT);
    }
    if deco.has(Deco::CODE) {
        style = style.fg(t().code);
    }
    if deco.has(Deco::LINK) {
        style = style.fg(t().accent).add_modifier(Modifier::UNDERLINED);
    }
    if deco.has(Deco::QUOTE) {
        style = style.fg(t().text_muted);
    }
    if deco.has(Deco::MENTION) {
        style = style.fg(t().accent).add_modifier(Modifier::BOLD);
    }
    if deco.has(Deco::MARKER) {
        style = style.fg(t().text_muted);
    }
    let pill = if deco.has(Deco::REACTION_MINE) {
        Some(t().accent_bg)
    } else if deco.has(Deco::REACTION) {
        Some(t().surface_2)
    } else {
        None
    };
    if let Some(bg) = pill {
        style = if deco.has(Deco::CAP) {
            style.fg(bg)
        } else {
            style.fg(t().on_accent).bg(bg)
        };
    }
    if deco.has(Deco::HIGHLIGHT) {
        style = style.bg(t().mark);
    }
    style
}

/// `text` を、装飾の範囲（`decos`。`text` 全体でのバイト位置）に沿って分ける。`from` は `text` の中の開始位置。
fn deco_spans(
    text: &str,
    from: usize,
    decos: &[(usize, usize, Deco)],
    base: Style,
) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut pos = from;
    for &(start, end, deco) in decos {
        if start < pos
            || end > text.len()
            || !text.is_char_boundary(start)
            || !text.is_char_boundary(end)
        {
            continue;
        }
        if start > pos {
            spans.push(Span::styled(text[pos..start].to_owned(), base));
        }
        spans.push(Span::styled(
            text[start..end].to_owned(),
            deco_style(deco, base),
        ));
        pos = end;
    }
    if pos < text.len() {
        spans.push(Span::styled(text[pos..].to_owned(), base));
    }
    spans
}

fn row_line(row: &Row, color: Color, hide_icon: bool, selected: bool) -> Line<'static> {
    match row.kind {
        RowKind::Separator => Line::from(Span::styled(
            row.text.clone(),
            Style::new().fg(t().text_muted),
        )),
        kind => {
            let (lead, _) = row.text.split_at(row.prefix.min(row.text.len()));
            let lead = if hide_icon {
                blank_first_cells(lead, 2)
            } else {
                lead.to_owned()
            };
            let rest_style = match kind {
                RowKind::Meta => Style::new().fg(t().text_muted),
                _ => Style::new(),
            };
            let lead_style = Style::new().fg(color).add_modifier(Modifier::BOLD);
            let mut spans = vec![Span::styled(lead, lead_style)];
            spans.extend(deco_spans(
                &row.text,
                row.prefix.min(row.text.len()),
                &row.decos,
                rest_style,
            ));
            if selected {
                let mark = Style::new().bg(t().surface);
                for span in &mut spans {
                    span.style = span.style.patch(mark);
                }
            }
            Line::from(spans)
        }
    }
}

/// 投稿者の色。アバターがあればその平均色、なければ ID から決めた色。
fn author_color(app: &App, row: &Row) -> Color {
    match app.author_color(&row.author_id) {
        Some((r, g, b)) => theme::rgb(r, g, b),
        None => t().palette[usize::from(row.accent) % t().palette.len()],
    }
}

/// 履歴の見えている範囲（`rows` の添字の範囲と、先頭の空き行数）。
fn visible(app: &App, rows: &[Row], height: u16) -> (usize, usize, usize) {
    let end = rows.len().saturating_sub(app.scroll);
    let start = end.saturating_sub(usize::from(height));
    let pad = usize::from(height).saturating_sub(end - start);
    (start, end, pad)
}

/// 画像を出す場所を決める。必要な画像の取得もここで依頼する。
pub fn plan(area: Rect, app: &mut App) {
    app.placements.clear();
    if app.gfx.is_none() || area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        return;
    }
    let (w, h) = history_size(area, app);
    app.set_viewport(w, h);
    if app.mode == Mode::Search || !app.modals.is_empty() || app.suggest.is_some() {
        // 検索の結果やモーダルを出している間は、履歴の画像を出さない（モーダルに重ならない）。
        app.placements = Vec::new();
        return;
    }
    let r = regions(area, app);
    let rows = app.rows();
    let (start, end, pad) = visible(app, &rows, r.history.height);
    let mut placements: Vec<Placement> = Vec::new();
    for (i, row) in rows[start..end].iter().enumerate() {
        let y = r.history.y + (pad + i) as u16;
        if let Some(key) = &row.avatar {
            app.want_image(key);
            if app.ready_image(key).is_some() {
                placements.push(Placement {
                    key: key.clone(),
                    col: r.history.x,
                    row: y,
                    cols: 2,
                    rows: 1,
                    src_start: 0,
                    src_end: 1,
                    src_total: 1,
                });
            }
        }
        for slot in &row.images {
            app.want_image(&slot.key);
            if app.ready_image(&slot.key).is_none() {
                continue;
            }
            // 同じ画像の続きの行なら 1 つの配置にまとめる（横に並んだ別の画像とは混ぜない）。
            match placements.iter_mut().rev().find(|p| p.key == slot.key) {
                Some(last)
                    if last.row + last.rows == y
                        && last.col == r.history.x + slot.offset
                        && last.src_end == slot.row =>
                {
                    last.rows += 1;
                    last.src_end += 1;
                }
                _ => placements.push(Placement {
                    key: slot.key.clone(),
                    col: r.history.x + slot.offset,
                    row: y,
                    cols: slot.cols,
                    rows: 1,
                    src_start: slot.row,
                    src_end: slot.row + 1,
                    src_total: slot.rows,
                }),
            }
        }
    }
    app.placements = placements;
}

/// 検索の結果の一覧（1 件 1 行、新しい順）。選んでいる行を強調し、見える範囲だけ出す。
fn search_lines(app: &App, width: u16, height: u16) -> Vec<Line<'static>> {
    let (width, height) = (usize::from(width), usize::from(height));
    let s = &app.search;
    let muted = Style::new().fg(t().text_muted);
    let note = |text: &str| vec![Line::from(Span::styled(text.to_owned(), muted))];
    if s.phase == Phase::Detail
        && let Some(m) = s.results.get(s.cursor)
    {
        let rows = transcript::message_rows_for(
            m,
            &app.users,
            width,
            app.zone.as_ref(),
            None,
            app.me.as_ref().map(|u| u.id.as_str()),
            &transcript::Media::NONE,
        );
        let when = match &app.zone {
            Some(zone) => crate::timefmt::format_in(m.created_at, zone, "%Y-%m-%d %H:%M:%S"),
            None => crate::timefmt::format_in(
                m.created_at,
                &jiff::tz::TimeZone::UTC,
                "%Y-%m-%d %H:%M:%SZ",
            ),
        };
        let mut lines = vec![Line::from(Span::styled(
            format!("{when}（検索結果の詳細。履歴には追加されません）"),
            muted,
        ))];
        let room = height.saturating_sub(1).max(1);
        let start = s.detail_scroll.min(rows.len().saturating_sub(room));
        for row in rows.iter().skip(start).take(room) {
            lines.push(row_line(row, Color::Reset, false, false));
        }
        return lines;
    }
    match s.phase {
        Phase::Loading => return note("検索中…"),
        Phase::Editing if s.results.is_empty() => {
            return note(
                "語を入力して Enter（空白で区切った語をすべて含むメッセージを、新しい順に出します）",
            );
        }
        Phase::Browsing if s.results.is_empty() => return note("一致するメッセージはありません"),
        _ => {}
    }
    let header = format!(
        "検索結果 {} 件{}{}",
        s.results.len(),
        if s.more {
            "以上（n: さらに古い結果）"
        } else {
            ""
        },
        if s.loading_more {
            " 読み込み中…"
        } else {
            ""
        },
    );
    let mut lines = vec![Line::from(Span::styled(header, muted))];
    let list_h = height.saturating_sub(1).max(1);
    let start = s
        .cursor
        .saturating_sub(list_h / 2)
        .min(s.results.len().saturating_sub(list_h));
    for (i, m) in s.results.iter().enumerate().skip(start).take(list_h) {
        let who = app
            .users
            .iter()
            .find(|u| u.id == m.author_id)
            .map_or(crate::tui::transcript::UNKNOWN_USER, |u| {
                u.display_name.as_str()
            });
        let when = match &app.zone {
            Some(zone) => crate::timefmt::format_in(m.created_at, zone, "%Y-%m-%d %H:%M"),
            None => {
                crate::timefmt::format_in(m.created_at, &jiff::tz::TimeZone::UTC, "%Y-%m-%d %H:%MZ")
            }
        };
        let selected = i == s.cursor;
        let text = format!(
            "{} {when} {}: {}",
            if selected { "▶" } else { " " },
            sanitize::inline(who),
            sanitize::inline(&m.body)
        );
        let mut style = Style::new();
        if selected {
            style = style.bg(t().surface).add_modifier(Modifier::BOLD);
        }
        lines.push(Line::from(Span::styled(
            sanitize::truncate(&text, width),
            style,
        )));
    }
    lines
}

/// 下部のナビゲーション。Chat だけが使え、未実装の Settings は選べない（無効表示）。
fn navbar_line(width: u16) -> Line<'static> {
    let cell = usize::from(width) / 2;
    let item = |label: &str, style: Style| {
        let pad = cell.saturating_sub(sanitize::display_width(label));
        let left = pad / 2;
        Span::styled(
            format!("{}{label}{}", " ".repeat(left), " ".repeat(pad - left)),
            style,
        )
    };
    let disabled = Style::new().fg(t().text_muted).add_modifier(Modifier::DIM);
    Line::from(vec![
        item(
            "Chat",
            Style::new().fg(t().accent).add_modifier(Modifier::BOLD),
        ),
        item("Settings", disabled),
    ])
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        frame.render_widget(Paragraph::new("画面が小さすぎます"), area);
        return;
    }
    let (w, h) = history_size(area, app);
    app.set_viewport(w, h);
    let r = regions(area, app);

    if r.status.height > 0 {
        frame.render_widget(
            Paragraph::new(sanitize::truncate(
                &status_text(app),
                usize::from(r.status.width),
            ))
            .style(Style::new().add_modifier(Modifier::REVERSED)),
            r.status,
        );
    }

    plan(area, app);
    if app.mode == Mode::Search {
        frame.render_widget(
            Paragraph::new(search_lines(app, r.history.width, r.history.height)),
            r.history,
        );
    }
    let rows = if app.mode == Mode::Search {
        Vec::new()
    } else {
        app.rows()
    };
    let (start, end, pad) = visible(app, &rows, r.history.height);
    let mut lines: Vec<Line> = rows[start..end]
        .iter()
        .map(|row| {
            let hide_icon = row
                .avatar
                .as_deref()
                .is_some_and(|k| app.ready_image(k).is_some());
            let selected =
                app.mode != Mode::Input && app.selected.as_deref() == Some(row.message_id.as_str());
            row_line(row, author_color(app, row), hide_icon, selected)
        })
        .collect();
    // 少ないときは下に寄せる（最新が入力欄の近くにある）。
    let mut padded = vec![Line::from(""); pad];
    padded.append(&mut lines);
    if app.mode != Mode::Search {
        frame.render_widget(Paragraph::new(padded), r.history);
    }

    if let Some((text, color)) = message_line(app) {
        frame.render_widget(
            Paragraph::new(sanitize::truncate(&text, usize::from(r.message.width)))
                .style(Style::new().fg(color)),
            r.message,
        );
    }

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(t().text_muted))
        .padding(Padding::horizontal(1));
    let box_area = Rect {
        width: r.input.width.saturating_sub(BUTTON_W),
        ..r.input
    };
    let inner = block.inner(box_area);
    frame.render_widget(block, box_area);
    // 送信ボタンは入力欄の右、下端にそろえる。
    let button_area = Rect {
        x: box_area.right(),
        y: r.input.bottom().saturating_sub(3),
        width: BUTTON_W.min(r.input.width),
        height: 3,
    };
    app.send_button = Some((
        button_area.x,
        button_area.y,
        button_area.width,
        button_area.height,
    ));
    let focused = app.focus == Focus::SendButton && app.modals.is_empty();
    let can_send = matches!(app.conn, ConnState::Connected { .. })
        && !app.input.as_str().trim().is_empty()
        && !app.input_locked();
    let (border, label) = if focused {
        (
            Style::new().fg(t().accent).add_modifier(Modifier::BOLD),
            Style::new()
                .fg(t().accent)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED),
        )
    } else if can_send {
        (Style::new().fg(t().accent), Style::new().fg(t().accent))
    } else {
        (
            Style::new().fg(t().text_muted),
            Style::new().fg(t().text_muted),
        )
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(" 送信 ", label))).block(
            Block::bordered()
                .border_type(BorderType::Rounded)
                .border_style(border),
        ),
        button_area,
    );
    let (input_rows, (cursor_row, cursor_col)) = app.input.layout(usize::from(inner.width).max(1));
    let height = usize::from(inner.height);
    let first = (cursor_row + 1).saturating_sub(height);
    let lines: Vec<Line> = if app.input.is_empty() {
        vec![Line::from(Span::styled(
            PLACEHOLDER,
            Style::new().fg(t().text_muted),
        ))]
    } else {
        input_rows
            .iter()
            .skip(first)
            .take(height)
            .map(|text| Line::from(text.clone()))
            .collect()
    };
    frame.render_widget(Paragraph::new(lines), inner);
    let x = inner.x + cursor_col as u16;
    let y = inner.y + (cursor_row - first) as u16;
    if !focused && app.mode == Mode::Input {
        frame.set_cursor_position((x.min(inner.right().saturating_sub(1)), y));
    }

    frame.render_widget(
        Paragraph::new(sanitize::truncate(
            &if let Some(modal) = app.modals.last() {
                modal_hint(modal).to_owned()
            } else if app.suggest.is_some() {
                "↑↓: 候補 | Tab/Enter: 決定 | Esc: 閉じる".to_owned()
            } else if app.mode == Mode::Select {
                format!(
                    "↑↓/j k: 選択 | ←→/h l: 画像を横へ | {}: メニュー | r: リアクション | 1-5: 👍🎉😂😮🙏 | p/Enter: 返信 | Esc: 戻る",
                    key_labels(app, crate::tui::commands::MESSAGE_MENU)
                )
            } else if app.mode == Mode::Search {
                match app.search.phase {
                    Phase::Editing => "Enter: 検索 | Esc: 閉じる | 空白で区切った語をすべて含むものを探します".to_owned(),
                    Phase::Loading => "検索中… | Esc: 入力へ戻る".to_owned(),
                    Phase::Detail => "↑↓/j k/PgUp/PgDn: スクロール | Esc/←: 結果へ戻る".to_owned(),
                    Phase::Browsing => "↑↓/j k: 選択 | Enter: そのメッセージへ（履歴に無ければ本文を表示） | d/→: 本文の詳細 | n: さらに古い結果 | /: 語を編集 | Esc: 入力へ戻る".to_owned(),
                }
            } else if focused {
                "送信ボタン: Enter / Space で送信 | Shift+Tab: 入力欄へ戻る".to_owned()
            } else {
                app.keymap.hint()
            },
            usize::from(r.hint.width),
        ))
        .style(Style::new().fg(t().text_muted)),
        r.hint,
    );
    frame.render_widget(Paragraph::new(navbar_line(r.navbar.width)), r.navbar);
    draw_suggest(frame, &r, app);
    draw_modal(frame, area, app);
}

/// 入力欄の上に補完の候補を重ねる（フォーカスは入力欄のまま）。
fn draw_suggest(frame: &mut Frame, r: &Regions, app: &App) {
    let Some(s) = app.suggest.as_ref().filter(|_| app.modals.is_empty()) else {
        return;
    };
    let text_w = |s: &str| unicode_width::UnicodeWidthStr::width(s);
    let labels: Vec<String> = s.items.iter().map(|i| sanitize::inline(&i.label)).collect();
    let width = (labels.iter().map(|l| text_w(l)).max().unwrap_or(0) as u16 + 4)
        .clamp(8, r.input.width.max(8));
    let height = (labels.len() as u16 + 2).min(r.input.y.max(3));
    let rect = Rect {
        x: r.input.x,
        y: r.input.y.saturating_sub(height),
        width: width.min(r.input.width.max(1)),
        height,
    };
    let selected = Style::new()
        .fg(t().on_accent)
        .bg(t().accent_bg)
        .add_modifier(Modifier::BOLD);
    let lines: Vec<Line> = labels
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let style = if i == s.cursor {
                selected
            } else {
                Style::new()
            };
            Line::from(Span::styled(format!(" {l} "), style))
        })
        .collect();
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(t().accent));
    frame.render_widget(ratatui::widgets::Clear, rect);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    frame.render_widget(Paragraph::new(lines), inner);
}

/// コマンドに割り当てたキーの表示（選択モード）。割り当てが無ければ `-`。
fn key_labels(app: &App, command: &str) -> String {
    use crate::tui::input::Action;
    let keys: Vec<String> = app
        .bindings
        .keys_for(Mode::Select, command)
        .into_iter()
        .map(|a| match a {
            Action::Insert(c) => c.to_string(),
            Action::Send | Action::Newline => "Enter".to_owned(),
            Action::Up => "↑".to_owned(),
            Action::Down => "↓".to_owned(),
            Action::Left => "←".to_owned(),
            Action::Right => "→".to_owned(),
            _ => "?".to_owned(),
        })
        .collect();
    if keys.is_empty() {
        "-".to_owned()
    } else {
        keys.join("/")
    }
}

fn modal_hint(modal: &Modal) -> &'static str {
    match modal {
        Modal::Settings(_) => "↑↓: 選択 | Enter: 変更 | Esc: 閉じる | クリック: 変更",
        Modal::Menu(_) | Modal::Choice(_) => {
            "↑↓/Tab: 選択 | Enter: 決定 | Esc: 閉じる | クリック: 決定"
        }
        Modal::Dialog(_) => "←→/Tab: ボタン選択 | Enter: 決定 | Esc: やめる",
        Modal::Prompt(_) => "Enter: 決定 | Esc: やめる",
    }
}

/// 最上位のモーダルを画面の中央に重ねて描く。当たり判定のため、領域を `app.modal_area` に残す。
fn draw_modal(frame: &mut Frame, area: Rect, app: &mut App) {
    if app.modals.is_empty() {
        app.modal_area = None;
        return;
    }
    // 設定画面の行は、現在の値から作る。見える行数は画面の高さで決まる。
    let settings_rows = match (app.modals.last(), &app.settings) {
        (Some(Modal::Settings(_)), Some(loaded)) => {
            Some(crate::tui::settings::rows(loaded, &app.bindings))
        }
        _ => None,
    };
    if let Some(Modal::Settings(s)) = app.modals.last_mut() {
        s.visible =
            crate::tui::ui::modal::WINDOW.min(usize::from(area.height.saturating_sub(4)).max(1));
    }
    let Some(modal) = app.modals.last() else {
        return;
    };
    let max_w = area.width.saturating_sub(4).max(1);
    let text_w = |s: &str| unicode_width::UnicodeWidthStr::width(s);
    // 本体の行（強調の有無つき）と、Dialog のメッセージの行数。
    let mut message_rows = 0u16;
    let mut body: Vec<Line> = Vec::new();
    let mut want = text_w(modal.title()) + 4;
    let selected = Style::new()
        .fg(t().on_accent)
        .bg(t().accent_bg)
        .add_modifier(Modifier::BOLD);
    match modal {
        Modal::Settings(s) => {
            let rows = settings_rows.unwrap_or_default();
            let first = s.window_first();
            let label_w = rows.iter().map(|r| text_w(&r.label)).max().unwrap_or(0);
            for (i, row) in rows.iter().enumerate().skip(first).take(s.visible) {
                let label = sanitize::inline(&row.label);
                let pad = " ".repeat(label_w.saturating_sub(text_w(&label)));
                let line = format!(" {label}{pad}  {} ", sanitize::inline(&row.value));
                want = want.max(text_w(&line) + 4);
                let style = if i == s.cursor {
                    selected
                } else {
                    Style::new()
                };
                body.push(Line::from(Span::styled(line, style)));
            }
        }
        Modal::Menu(m) => {
            for (i, item) in m.items.iter().enumerate() {
                let label = sanitize::inline(&item.label);
                want = want.max(text_w(&label) + 6);
                let style = if i == m.cursor {
                    selected
                } else {
                    Style::new()
                };
                body.push(Line::from(Span::styled(format!(" {label} "), style)));
            }
        }
        Modal::Choice(c) => {
            for (i, option) in c.options.iter().enumerate() {
                let label = sanitize::inline(option);
                want = want.max(text_w(&label) + 6);
                let style = if i == c.cursor {
                    selected
                } else {
                    Style::new()
                };
                let mark = if i == c.cursor { "●" } else { "○" };
                body.push(Line::from(Span::styled(format!(" {mark} {label} "), style)));
            }
        }
        Modal::Dialog(d) => {
            let width = usize::from(max_w).saturating_sub(4).clamp(10, 56);
            want = want.max(width + 4);
            let lines = sanitize::wrap(&sanitize::inline(&d.message), width);
            message_rows = lines.len() as u16;
            body.extend(lines.into_iter().map(Line::from));
            body.push(Line::from(""));
            let mut spans = Vec::new();
            for (i, b) in d.buttons.iter().enumerate() {
                if i > 0 {
                    spans.push(Span::raw(" "));
                }
                let style = if i == d.focus {
                    selected
                } else {
                    Style::new().fg(t().text_muted)
                };
                spans.push(Span::styled(
                    format!("[ {} ]", sanitize::inline(&b.label)),
                    style,
                ));
            }
            body.push(Line::from(spans));
        }
        Modal::Prompt(p) => {
            want = want.max(36);
            body.push(Line::from(format!(
                "{}▏",
                sanitize::inline(p.text.as_str())
            )));
        }
    }
    let w = (want as u16).clamp(10, max_w);
    let h = (body.len() as u16 + 2).min(area.height);
    let rect = Rect {
        x: area.x + area.width.saturating_sub(w) / 2,
        y: area.y + area.height.saturating_sub(h) / 2,
        width: w.min(area.width),
        height: h,
    };
    app.modal_area = Some((rect.x, rect.y, rect.width, rect.height, message_rows));
    let danger = matches!(modal, Modal::Dialog(_));
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(if danger { t().warning } else { t().accent }))
        .title(sanitize::truncate(
            modal.title(),
            usize::from(w.saturating_sub(4)),
        ))
        .padding(Padding::horizontal(1));
    frame.render_widget(ratatui::widgets::Clear, rect);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    frame.render_widget(Paragraph::new(body), inner);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::app::{Event, NetEvent};
    use crate::tui::input::{EnterKeys, Keymap};
    use crate::tui::transcript::tests_support::{message, user};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn app() -> App {
        let mut n = 0;
        App::new(
            None,
            Keymap::new(EnterKeys::default(), true),
            None,
            Box::new(move || {
                n += 1;
                format!("id{n}")
            }),
        )
    }

    fn render(app: &mut App, w: u16, h: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| draw(f, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..h)
            // 全角文字の後ろのセルは空白になるため、空白を除いて比べる。
            .map(|y| {
                (0..w)
                    .flat_map(|x| buffer[(x, y)].symbol().chars().collect::<Vec<_>>())
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>()
            })
            .collect()
    }

    fn connect(app: &mut App) {
        app.update(Event::Net(NetEvent::Connected {
            generation: 1,
            me: user("u1", "Alice"),
            users: vec![user("u1", "Alice"), user("u2", "Bob")],
        }));
    }

    /// 画像の要求・平均色・配置まで、描画の経路を通しで確かめる。
    #[test]
    fn avatars_and_thumbnails_are_requested_colored_and_placed() {
        let mut app = app();
        app.enable_images((8, 16));
        let mut bob = user("u2", "Bob");
        bob.avatar_url = Some("/api/avatars/abc".into());
        app.update(Event::Net(NetEvent::Connected {
            generation: 1,
            me: user("u1", "Alice"),
            users: vec![user("u1", "Alice"), bob],
        }));
        let mut m = message("m1", "u2", "こんにちは");
        m.attachments.push(disnans_shared::Attachment {
            id: "att1".into(),
            file_name: "p.png".into(),
            mime: "image/png".into(),
            size: 10,
            width: Some(100),
            height: Some(100),
            has_thumb: true,
            deleted: false,
        });
        app.messages.push(m);
        render(&mut app, 60, 20);
        let mut wanted = app.take_image_requests();
        wanted.sort();
        assert_eq!(wanted, ["/api/avatars/abc", "/api/files/att1/thumb"]);
        let img = |color| {
            Box::new(crate::tui::picture::Prepared {
                png: vec![],
                rgba: image::RgbaImage::new(2, 2),
                color,
            })
        };
        for (key, color) in [
            ("/api/avatars/abc", (10, 200, 30)),
            ("/api/files/att1/thumb", (0, 0, 0)),
        ] {
            app.update(Event::Net(NetEvent::Image {
                key: key.into(),
                result: Ok(img(color)),
            }));
        }
        render(&mut app, 60, 20);
        assert_eq!(app.author_color("u2"), Some((10, 200, 30)));
        let keys: Vec<&str> = app.placements.iter().map(|p| p.key.as_str()).collect();
        assert!(keys.contains(&"/api/avatars/abc"), "{keys:?}");
        assert!(keys.contains(&"/api/files/att1/thumb"), "{keys:?}");
    }

    #[test]
    fn my_reactions_are_marked_mine() {
        let mut app = app();
        connect(&mut app);
        let mut m = message("m1", "u2", "x");
        m.reactions.push(disnans_shared::Reaction {
            emoji: "👍".into(),
            user_ids: vec!["u1".into()],
        });
        app.messages.push(m);
        let rows = app.rows();
        assert!(
            rows.iter()
                .flat_map(|r| r.decos.iter())
                .any(|(_, _, d)| d.has(Deco::REACTION_MINE))
        );
    }

    #[test]
    fn shows_status_names_and_bodies() {
        let mut app = app();
        connect(&mut app);
        app.messages.push(message("m1", "u2", "こんにちは"));
        let screen = render(&mut app, 60, 12).join("\n");
        assert!(
            screen.contains("Chat") && screen.contains("Settings"),
            "{screen}"
        );
        assert!(screen.contains("Bob"), "{screen}");
        assert!(screen.contains("こんにちは"), "{screen}");
        assert!(screen.contains("Ctrl+S"), "{screen}");
    }

    #[test]
    fn disconnected_and_failed_states_are_visible() {
        let mut app = app();
        app.conn = ConnState::Reconnecting {
            generation: 2,
            reason: "closed".into(),
        };
        assert!(render(&mut app, 80, 12)[0].contains("切断・再接続中"));
        app.conn = ConnState::Failed {
            reason: "forbidden".into(),
            http_status: Some(403),
        };
        let top = render(&mut app, 80, 12)[0].clone();
        assert!(top.contains("接続できませんHTTP403"), "{top}");
    }

    #[test]
    fn terminal_control_sequences_from_the_server_never_reach_the_screen() {
        let mut app = app();
        app.messages.push(message("m1", "u2", "\u{1b}[2Jevil\u{7}"));
        app.users.push(user("u2", "B\u{1b}ob"));
        let screen = render(&mut app, 60, 12).join("\n");
        assert!(screen.contains("\\u{1B}[2Jevil\\u{7}"), "{screen}");
        assert!(!screen.chars().any(|c| c.is_control() && c != '\n'));
    }

    #[test]
    fn too_small_terminals_show_a_notice_instead_of_panicking() {
        let mut app = app();
        assert!(render(&mut app, 10, 4)[0].contains("画面が"));
        let _ = render(&mut app, 1, 1);
    }

    #[test]
    fn unknown_send_keeps_a_visible_warning_with_the_client_id() {
        let mut app = app();
        app.send = SendState::Unknown {
            client_id: "abc".into(),
            body: "x".into(),
            detail: "timeout".into(),
        };
        let line = message_line(&app).unwrap().0;
        assert!(line.contains("再送していません") && line.contains("abc"));
    }

    #[test]
    fn long_input_is_wrapped_and_limited_to_a_few_rows() {
        let mut app = app();
        app.input = crate::tui::textbuf::TextBuf::from_text(&"あ".repeat(200));
        let screen = render(&mut app, 40, 20);
        assert!(screen.iter().any(|l| l.contains("│あ")));
        assert!(screen.last().unwrap().contains("Settings"));
        assert!(screen[screen.len() - 2].contains("送信"));
    }

    #[test]
    fn narrow_layout_has_icon_rows_date_separator_box_and_navbar() {
        let mut app = app();
        connect(&mut app);
        app.messages.push(message("m1", "u2", "晴れだよ"));
        let screen = render(&mut app, 40, 14);
        let all = screen.join("\n");
        assert!(
            all.contains("B Bob晴れだよ") || all.contains("BBob晴れだよ"),
            "{all}"
        );
        assert!(
            all.contains("月") || all.contains("火") || all.contains("日"),
            "{all}"
        );
        assert!(all.contains("╭") && all.contains("╰"), "{all}");
        assert!(all.contains("ここにテキストを入力"), "{all}");
        assert!(screen.last().unwrap().contains("Chat"));
    }

    #[test]
    fn send_button_is_drawn_and_focus_changes_the_hint() {
        let mut app = app();
        connect(&mut app);
        let screen = render(&mut app, 40, 14).join("\n");
        assert!(
            screen.contains("送信") && screen.matches('╭').count() >= 2,
            "{screen}"
        );
        app.focus = Focus::SendButton;
        let screen = render(&mut app, 80, 14).join("\n");
        assert!(screen.contains("Shift+Tab"), "{screen}");
    }

    #[test]
    fn plan_places_loaded_images_and_requests_missing_ones() {
        use crate::tui::picture::{Kind, prepare};
        let mut app = app();
        connect(&mut app);
        app.enable_images((8, 16));
        app.users[1].avatar_url = Some("/api/avatars/b".into());
        app.messages.push(message("m1", "u2", "やあ"));
        let area = Rect::new(0, 0, 40, 14);
        plan(area, &mut app);
        assert!(app.placements.is_empty());
        assert_eq!(app.take_image_requests(), ["/api/avatars/b"]);
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 9, 9, 255]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let ready = prepare(&png, Kind::Avatar).unwrap();
        app.update(Event::Net(NetEvent::Image {
            key: "/api/avatars/b".into(),
            result: Ok(Box::new(ready)),
        }));
        plan(area, &mut app);
        assert_eq!(app.placements.len(), 1);
        let p = &app.placements[0];
        assert_eq!((p.col, p.cols, p.rows), (0, 2, 1));
    }

    #[test]
    fn modal_is_drawn_centered_records_its_area_and_hides_images() {
        use crate::tui::ui::modal::{Dialog, Menu, MenuItem};
        let mut app = app();
        connect(&mut app);
        app.enable_images((8, 16));
        app.modals.push(Modal::Menu(Menu::new(
            "操作",
            vec![MenuItem::new("返信", "a"), MenuItem::new("閉じる", "b")],
        )));
        let lines = render(&mut app, 40, 14);
        assert!(lines.iter().any(|l| l.contains("操作")));
        assert!(lines.iter().any(|l| l.contains("返信")));
        let (x, y, w, h, _) = app.modal_area.unwrap();
        assert!(x > 0 && y > 0 && x + w < 40 && y + h < 14);
        plan(Rect::new(0, 0, 40, 14), &mut app);
        assert!(app.placements.is_empty());
        app.modals.push(Modal::Dialog(Dialog::confirm(
            "確認",
            "よろしいですか",
            "やめる",
            "送る",
            "c",
        )));
        let lines = render(&mut app, 40, 14);
        assert!(
            lines.iter().any(|l| l.contains("[やめる][送る]")),
            "{lines:?}"
        );
        assert!(app.modal_area.unwrap().4 >= 1);
        app.modals.clear();
        render(&mut app, 40, 14);
        assert!(app.modal_area.is_none());
    }

    #[test]
    fn suggest_popup_is_drawn_above_the_input_and_hides_images() {
        let mut app = app();
        connect(&mut app);
        app.users.push(user("u9", "Zed"));
        app.enable_images((8, 16));
        app.update(Event::Paste("@ze".into()));
        assert!(app.suggest.is_some());
        let lines = render(&mut app, 50, 14);
        assert!(lines.iter().any(|l| l.contains("@Zed")), "{lines:?}");
        plan(Rect::new(0, 0, 50, 14), &mut app);
        assert!(app.placements.is_empty());
    }

    #[test]
    fn settings_screen_lists_rows_from_the_loaded_values() {
        use crate::tui::device::Loaded;
        use crate::tui::ui::modal::SettingsList;
        let mut app = app();
        connect(&mut app);
        app.settings = Some(Loaded {
            device_id: "d".into(),
            device_name: "Linux (TUI)".into(),
            user: serde_json::json!({"theme": "dark"}),
            device: serde_json::json!({}),
        });
        app.modals.push(Modal::Settings(SettingsList {
            cursor: 0,
            len: 20,
            visible: 20,
        }));
        let lines = render(&mut app, 70, 30);
        assert!(
            lines.iter().any(|l| l.contains("[共通]テーマdark")),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l.contains("Linux(TUI)")));
    }
}
