//! ratatui での描画。端末へ渡す文字列はすべてエスケープ済みのものだけを使う。

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};

use super::app::{App, ConnState, Focus, ImageState, SendState};
use super::commands::Mode;
use super::graphics::Placement;
use super::markdown::Deco;
use super::sanitize;
use super::transcript::{self, Row, RowKind};

pub const MIN_WIDTH: u16 = 20;
pub const MIN_HEIGHT: u16 = 8;
const MAX_INPUT_ROWS: usize = 5;
const BLUE: Color = Color::Rgb(90, 150, 255);
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
        SendState::Sending { .. } => return Some(("送信中…".into(), Color::Yellow)),
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
                Color::Red,
            ));
        }
        _ => {}
    }
    if app.mode == Mode::React {
        return Some((
            format!(
                "リアクション（絵文字）: {}▏",
                sanitize::inline(app.react_input.as_str())
            ),
            Color::Yellow,
        ));
    }
    if app.mode == Mode::Select {
        return Some(("メッセージを選択中".into(), Color::Yellow));
    }
    if let Some((title, body)) = &app.alert {
        return Some((
            format!(
                "通知: {} {}",
                sanitize::inline(title),
                sanitize::inline(body)
            ),
            Color::Cyan,
        ));
    }
    if let Some(notice) = &app.notice {
        return Some((notice.clone(), Color::Yellow));
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
                sanitize::truncate(&sanitize::inline(excerpt), 30)
            ),
            Color::Cyan,
        ));
    }
    app.history_error.clone().map(|e| (e, Color::Red))
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

/// 履歴領域の大きさ（桁・行）。端末サイズの変化のたびに `App` へ伝える。
pub fn history_size(area: Rect, app: &App) -> (usize, usize) {
    let r = regions(area, app);
    (usize::from(r.history.width), usize::from(r.history.height))
}

const ACCENT_COLORS: [Color; transcript::ACCENTS] = [
    Color::Cyan,
    Color::Green,
    Color::Magenta,
    Color::Yellow,
    Color::LightBlue,
    Color::LightRed,
];

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

/// Markdown の装飾を端末の修飾・色にする。
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
        style = style.fg(Color::Rgb(230, 190, 120));
    }
    if deco.has(Deco::LINK) {
        style = style.fg(BLUE).add_modifier(Modifier::UNDERLINED);
    }
    if deco.has(Deco::QUOTE) {
        style = style.fg(Color::DarkGray);
    }
    if deco.has(Deco::MENTION) {
        style = style.fg(BLUE).add_modifier(Modifier::BOLD);
    }
    if deco.has(Deco::HIGHLIGHT) {
        style = style.bg(Color::Rgb(90, 80, 20));
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

fn row_line(
    row: &Row,
    color: Color,
    hide_icon: bool,
    note: Option<&str>,
    selected: bool,
) -> Line<'static> {
    match row.kind {
        RowKind::Separator => Line::from(Span::styled(
            row.text.clone(),
            Style::new().fg(Color::DarkGray),
        )),
        kind => {
            let (lead, rest) = row.text.split_at(row.prefix.min(row.text.len()));
            let lead = if hide_icon {
                blank_first_cells(lead, 2)
            } else {
                lead.to_owned()
            };
            let rest_style = match kind {
                RowKind::Meta => Style::new().fg(Color::DarkGray),
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
            if let Some(note) = note {
                spans.push(Span::styled(
                    note.to_owned(),
                    Style::new().fg(Color::DarkGray),
                ));
            }
            if selected {
                let mark = Style::new().bg(Color::Rgb(45, 45, 75));
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
        Some((r, g, b)) => Color::Rgb(r, g, b),
        None => ACCENT_COLORS[usize::from(row.accent) % ACCENT_COLORS.len()],
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
        if let Some(slot) = &row.image {
            app.want_image(&slot.key);
            if app.ready_image(&slot.key).is_none() {
                continue;
            }
            match placements.last_mut() {
                Some(last)
                    if last.key == slot.key
                        && last.row + last.rows == y
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
    let disabled = Style::new().fg(Color::DarkGray).add_modifier(Modifier::DIM);
    Line::from(vec![
        item("Chat", Style::new().fg(BLUE).add_modifier(Modifier::BOLD)),
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
    let rows = app.rows();
    let (start, end, pad) = visible(app, &rows, r.history.height);
    let mut lines: Vec<Line> = rows[start..end]
        .iter()
        .map(|row| {
            let hide_icon = row
                .avatar
                .as_deref()
                .is_some_and(|k| app.ready_image(k).is_some());
            let note = row.image.as_ref().filter(|s| s.row == 0).and_then(|s| {
                match app.images.get(&s.key) {
                    Some(ImageState::Failed) => Some("(画像を表示できません)"),
                    Some(ImageState::Ready(_)) => None,
                    _ => Some("(画像を読み込み中…)"),
                }
            });
            let selected =
                app.mode != Mode::Input && app.selected.as_deref() == Some(row.message_id.as_str());
            row_line(row, author_color(app, row), hide_icon, note, selected)
        })
        .collect();
    // 少ないときは下に寄せる（最新が入力欄の近くにある）。
    let mut padded = vec![Line::from(""); pad];
    padded.append(&mut lines);
    frame.render_widget(Paragraph::new(padded), r.history);

    if let Some((text, color)) = message_line(app) {
        frame.render_widget(
            Paragraph::new(sanitize::truncate(&text, usize::from(r.message.width)))
                .style(Style::new().fg(color)),
            r.message,
        );
    }

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(Color::DarkGray))
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
    let focused = app.focus == Focus::SendButton;
    let can_send = matches!(app.conn, ConnState::Connected { .. })
        && !app.input.as_str().trim().is_empty()
        && !app.input_locked();
    let (border, label) = if focused {
        (
            Style::new().fg(BLUE).add_modifier(Modifier::BOLD),
            Style::new()
                .fg(BLUE)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED),
        )
    } else if can_send {
        (Style::new().fg(BLUE), Style::new().fg(BLUE))
    } else {
        (
            Style::new().fg(Color::DarkGray),
            Style::new().fg(Color::DarkGray),
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
            Style::new().fg(Color::DarkGray),
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
            &if app.mode == Mode::Select {
                "↑↓/j k: 選択 | r: リアクション | 1-5: 👍🎉😂😮🙏 | p/Enter: 返信 | Esc: 戻る"
                    .to_owned()
            } else if app.mode == Mode::React {
                "Enter: 付ける/外す | Esc: 戻る".to_owned()
            } else if focused {
                "送信ボタン: Enter / Space で送信 | Shift+Tab: 入力欄へ戻る".to_owned()
            } else {
                app.keymap.hint()
            },
            usize::from(r.hint.width),
        ))
        .style(Style::new().fg(Color::DarkGray)),
        r.hint,
    );
    frame.render_widget(Paragraph::new(navbar_line(r.navbar.width)), r.navbar);
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
}
