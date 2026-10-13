//! ratatui での描画。端末へ渡す文字列はすべてエスケープ済みのものだけを使う。

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::app::{App, ConnState, SendState};
use super::sanitize;
use super::transcript::RowKind;

pub const MIN_WIDTH: u16 = 20;
pub const MIN_HEIGHT: u16 = 8;
const MAX_INPUT_ROWS: usize = 5;
const PROMPT: &str = "> ";

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
    input: Rect,
    hint: Rect,
}

fn regions(area: Rect, app: &App) -> Regions {
    let input_width = usize::from(area.width).saturating_sub(PROMPT.len()).max(1);
    let wanted = app
        .input
        .layout(input_width)
        .0
        .len()
        .clamp(1, MAX_INPUT_ROWS);
    let input_height = wanted.min(usize::from(area.height.saturating_sub(5)).max(1)) as u16;
    let [status, history, message, input, hint] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(input_height),
        Constraint::Length(1),
    ])
    .areas(area);
    Regions {
        status,
        history,
        message,
        input,
        hint,
    }
}

/// 履歴領域の大きさ（桁・行）。端末サイズの変化のたびに `App` へ伝える。
pub fn history_size(area: Rect, app: &App) -> (usize, usize) {
    let r = regions(area, app);
    (usize::from(r.history.width), usize::from(r.history.height))
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

    frame.render_widget(
        Paragraph::new(sanitize::truncate(
            &status_text(app),
            usize::from(r.status.width),
        ))
        .style(Style::new().add_modifier(Modifier::REVERSED)),
        r.status,
    );

    let rows = app.rows();
    let end = rows.len().saturating_sub(app.scroll);
    let start = end.saturating_sub(usize::from(r.history.height));
    let mut lines: Vec<Line> = rows[start..end]
        .iter()
        .map(|row| {
            let style = match row.kind {
                RowKind::Header => Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                RowKind::Body => Style::new(),
                RowKind::Meta => Style::new().fg(Color::DarkGray),
            };
            Line::from(Span::styled(row.text.clone(), style))
        })
        .collect();
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

    let input_width = usize::from(r.input.width)
        .saturating_sub(PROMPT.len())
        .max(1);
    let (input_rows, (cursor_row, cursor_col)) = app.input.layout(input_width);
    let height = usize::from(r.input.height);
    let first = (cursor_row + 1).saturating_sub(height);
    let lines: Vec<Line> = input_rows
        .iter()
        .skip(first)
        .take(height)
        .enumerate()
        .map(|(i, text)| {
            let lead = if first + i == 0 { PROMPT } else { "  " };
            Line::from(format!("{lead}{text}"))
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), r.input);
    let x = r.input.x + (PROMPT.len() + cursor_col) as u16;
    let y = r.input.y + (cursor_row - first) as u16;
    frame.set_cursor_position((x.min(r.input.right().saturating_sub(1)), y));

    frame.render_widget(
        Paragraph::new(sanitize::truncate(
            &app.keymap.hint(),
            usize::from(r.hint.width),
        ))
        .style(Style::new().fg(Color::DarkGray)),
        r.hint,
    );
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
        assert!(screen.contains("接続済み"), "{screen}");
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
        assert!(render(&mut app, 80, 10)[0].contains("切断・再接続中"));
        app.conn = ConnState::Failed {
            reason: "forbidden".into(),
            http_status: Some(403),
        };
        let top = render(&mut app, 80, 10)[0].clone();
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
        assert!(screen.iter().any(|l| l.starts_with("あ")));
        assert!(screen.last().unwrap().contains("送信"));
    }
}
