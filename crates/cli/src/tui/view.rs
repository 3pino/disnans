//! ratatui での描画。端末へ渡す文字列はすべてエスケープ済みのものだけを使う。

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Paragraph};

use super::app::{App, ConnState, SendState};
use super::sanitize;
use super::transcript::{self, Row, RowKind};

pub const MIN_WIDTH: u16 = 20;
pub const MIN_HEIGHT: u16 = 8;
const MAX_INPUT_ROWS: usize = 5;
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
    if let Some(notice) = &app.notice {
        return Some((notice.clone(), Color::Yellow));
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
    usize::from(width).saturating_sub(4).max(1)
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

fn row_line(row: &Row) -> Line<'static> {
    match row.kind {
        RowKind::Separator => Line::from(Span::styled(
            row.text.clone(),
            Style::new().fg(Color::DarkGray),
        )),
        kind => {
            let (lead, rest) = row.text.split_at(row.prefix.min(row.text.len()));
            let rest_style = match kind {
                RowKind::Meta => Style::new().fg(Color::DarkGray),
                _ => Style::new(),
            };
            let lead_style = Style::new()
                .fg(ACCENT_COLORS[usize::from(row.accent) % ACCENT_COLORS.len()])
                .add_modifier(Modifier::BOLD);
            Line::from(vec![
                Span::styled(lead.to_owned(), lead_style),
                Span::styled(rest.to_owned(), rest_style),
            ])
        }
    }
}

/// 下部のナビゲーション。Chat だけが使え、未実装の Threads / Settings は選べない（無効表示）。
fn navbar_line(width: u16) -> Line<'static> {
    let cell = usize::from(width) / 3;
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
        item(
            "Chat",
            Style::new().add_modifier(Modifier::BOLD | Modifier::REVERSED),
        ),
        item("Threads", disabled),
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

    let rows = app.rows();
    let end = rows.len().saturating_sub(app.scroll);
    let start = end.saturating_sub(usize::from(r.history.height));
    let mut lines: Vec<Line> = rows[start..end].iter().map(row_line).collect();
    // 少ないときは下に寄せる（最新が入力欄の近くにある）。
    let pad = usize::from(r.history.height).saturating_sub(lines.len());
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
    let inner = block.inner(r.input);
    frame.render_widget(block, r.input);
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
    frame.set_cursor_position((x.min(inner.right().saturating_sub(1)), y));

    frame.render_widget(
        Paragraph::new(sanitize::truncate(
            &app.keymap.hint(),
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
            screen.contains("Chat") && screen.contains("Threads"),
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
}
