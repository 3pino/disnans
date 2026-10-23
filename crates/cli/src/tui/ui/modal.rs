//! モーダルの部品（Menu / Choice / Dialog / Prompt）。状態と操作だけを持ち、端末や通信には触れない。
//! 描画は `view.rs`。操作は `Action`（キー・マウスから変換済み）で受け、結果の `Outcome` を返す。
//! モーダルはスタックに積まれ、最上位だけが操作を受ける。

use unicode_width::UnicodeWidthStr;

use crate::tui::input::Action;
use crate::tui::textbuf::TextBuf;

/// 操作の結果。`Run` / `Submit` / `Close` は、呼び出し側がそのモーダルをスタックから外す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Keep,
    Close,
    /// コマンド ID を実行する。
    Run(String),
    /// 入力された値つきでコマンドを実行する。
    Submit(String, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
    pub label: String,
    pub command: String,
}

impl MenuItem {
    pub fn new(label: &str, command: &str) -> Self {
        Self {
            label: label.to_owned(),
            command: command.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Menu {
    pub title: String,
    pub items: Vec<MenuItem>,
    pub cursor: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub title: String,
    pub options: Vec<String>,
    /// 決定したときに返す値の種類を示すコマンド。
    pub command: String,
    pub cursor: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub label: String,
    pub command: String,
}

/// 確認など。`focus` の初期値は「やめる」側（最初のボタン）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dialog {
    pub title: String,
    pub message: String,
    pub buttons: Vec<Button>,
    pub focus: usize,
}

/// 1 行の入力つきのダイアログ。
#[derive(Debug, Clone)]
pub struct Prompt {
    pub title: String,
    pub command: String,
    pub text: TextBuf,
}

#[derive(Debug, Clone)]
pub enum Modal {
    Menu(Menu),
    #[allow(dead_code)] // 設定画面で使う
    Choice(Choice),
    Dialog(Dialog),
    Prompt(Prompt),
}

impl Menu {
    pub fn new(title: &str, items: Vec<MenuItem>) -> Self {
        Self {
            title: title.to_owned(),
            items,
            cursor: 0,
        }
    }
}

impl Choice {
    #[allow(dead_code)] // 設定画面で使う
    pub fn new(title: &str, command: &str, options: Vec<String>, selected: usize) -> Self {
        let cursor = selected.min(options.len().saturating_sub(1));
        Self {
            title: title.to_owned(),
            options,
            command: command.to_owned(),
            cursor,
        }
    }
}

impl Dialog {
    /// 確認。最初のボタン（`cancel`）が既定で、Esc もこれと同じ（何も実行しない）。
    pub fn confirm(title: &str, message: &str, cancel: &str, ok: &str, ok_command: &str) -> Self {
        Self {
            title: title.to_owned(),
            message: message.to_owned(),
            buttons: vec![
                Button {
                    label: cancel.to_owned(),
                    command: String::new(),
                },
                Button {
                    label: ok.to_owned(),
                    command: ok_command.to_owned(),
                },
            ],
            focus: 0,
        }
    }

    /// 各ボタンの `[ 表示 ]` の（開始桁, 終了桁）。メッセージ領域の左端を 0 とする。
    pub fn button_spans(&self) -> Vec<(u16, u16)> {
        let mut x = 0u16;
        self.buttons
            .iter()
            .map(|b| {
                let w = (b.label.width() + 4) as u16;
                let span = (x, x + w);
                x += w + 1;
                span
            })
            .collect()
    }
}

/// 上下・Tab でのカーソル移動（端で止まらずにまわる）。
fn step(cursor: usize, len: usize, action: &Action) -> Option<usize> {
    if len == 0 {
        return None;
    }
    match action {
        Action::Down | Action::FocusButton => Some((cursor + 1) % len),
        Action::Up | Action::FocusInput => Some((cursor + len - 1) % len),
        Action::Home | Action::ScrollTop => Some(0),
        Action::End | Action::ScrollBottom => Some(len - 1),
        _ => None,
    }
}

fn is_enter(action: &Action) -> bool {
    matches!(action, Action::Send | Action::Newline)
}

impl Modal {
    pub fn on_action(&mut self, action: &Action) -> Outcome {
        match self {
            Modal::Menu(m) => {
                if matches!(action, Action::Cancel) {
                    return Outcome::Close;
                }
                if let Some(c) = step(m.cursor, m.items.len(), action) {
                    m.cursor = c;
                } else if (is_enter(action) || matches!(action, Action::Insert(' ')))
                    && let Some(item) = m.items.get(m.cursor)
                {
                    return Outcome::Run(item.command.clone());
                }
                Outcome::Keep
            }
            Modal::Choice(c) => {
                if matches!(action, Action::Cancel) {
                    return Outcome::Close;
                }
                if let Some(next) = step(c.cursor, c.options.len(), action) {
                    c.cursor = next;
                } else if (is_enter(action) || matches!(action, Action::Insert(' ')))
                    && let Some(option) = c.options.get(c.cursor)
                {
                    return Outcome::Submit(c.command.clone(), option.clone());
                }
                Outcome::Keep
            }
            Modal::Dialog(d) => {
                let len = d.buttons.len();
                match action {
                    Action::Cancel => Outcome::Close,
                    Action::Right | Action::FocusButton | Action::Down => {
                        d.focus = (d.focus + 1) % len.max(1);
                        Outcome::Keep
                    }
                    Action::Left | Action::FocusInput | Action::Up => {
                        d.focus = (d.focus + len.max(1) - 1) % len.max(1);
                        Outcome::Keep
                    }
                    a if is_enter(a) || matches!(a, Action::Insert(' ')) => {
                        activate(d.buttons.get(d.focus).map(|b| b.command.as_str()))
                    }
                    _ => Outcome::Keep,
                }
            }
            Modal::Prompt(p) => {
                match action {
                    Action::Cancel => return Outcome::Close,
                    a if is_enter(a) => {
                        return Outcome::Submit(p.command.clone(), p.text.as_str().to_owned());
                    }
                    Action::Insert(c) => p.text.insert_char(*c),
                    Action::Backspace => p.text.backspace(),
                    Action::Delete => p.text.delete(),
                    Action::Left => p.text.left(),
                    Action::Right => p.text.right(),
                    Action::Home => p.text.home(),
                    Action::End => p.text.end(),
                    _ => {}
                }
                Outcome::Keep
            }
        }
    }

    /// クリック。`row` / `col` は内側（枠・見出しを除く本体）の左上を 0 とした位置。
    /// `row` は Menu / Choice では項目の行、Dialog ではメッセージ領域の左端基準の `col` でボタンを選ぶ。
    pub fn on_click(&mut self, row: u16, col: u16, message_rows: u16) -> Outcome {
        match self {
            Modal::Menu(m) => match m.items.get(usize::from(row)) {
                Some(item) => {
                    m.cursor = usize::from(row);
                    Outcome::Run(item.command.clone())
                }
                None => Outcome::Keep,
            },
            Modal::Choice(c) => match c.options.get(usize::from(row)) {
                Some(option) => {
                    c.cursor = usize::from(row);
                    Outcome::Submit(c.command.clone(), option.clone())
                }
                None => Outcome::Keep,
            },
            Modal::Dialog(d) => {
                if row != message_rows + 1 {
                    return Outcome::Keep;
                }
                match d
                    .button_spans()
                    .iter()
                    .position(|&(s, e)| (s..e).contains(&col))
                {
                    Some(i) => {
                        d.focus = i;
                        activate(d.buttons.get(i).map(|b| b.command.as_str()))
                    }
                    None => Outcome::Keep,
                }
            }
            Modal::Prompt(_) => Outcome::Keep,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Modal::Menu(m) => &m.title,
            Modal::Choice(c) => &c.title,
            Modal::Dialog(d) => &d.title,
            Modal::Prompt(p) => &p.title,
        }
    }
}

/// 空のコマンドは「何も実行しない」ボタン（やめる）。
fn activate(command: Option<&str>) -> Outcome {
    match command {
        Some(c) if !c.is_empty() => Outcome::Run(c.to_owned()),
        _ => Outcome::Close,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menu() -> Modal {
        Modal::Menu(Menu::new(
            "m",
            vec![MenuItem::new("a", "x.a"), MenuItem::new("b", "x.b")],
        ))
    }

    #[test]
    fn menu_moves_around_and_runs_the_item_or_closes() {
        let mut m = menu();
        assert_eq!(m.on_action(&Action::Down), Outcome::Keep);
        assert_eq!(m.on_action(&Action::Send), Outcome::Run("x.b".into()));
        m.on_action(&Action::Down);
        assert_eq!(m.on_action(&Action::Send), Outcome::Run("x.a".into()));
        assert_eq!(m.on_action(&Action::Cancel), Outcome::Close);
        assert_eq!(m.on_click(1, 0, 0), Outcome::Run("x.b".into()));
        assert_eq!(m.on_click(5, 0, 0), Outcome::Keep);
    }

    #[test]
    fn confirm_dialog_defaults_to_cancel_and_ok_needs_a_deliberate_move() {
        let mut d = Modal::Dialog(Dialog::confirm("t", "m", "やめる", "送る", "do.it"));
        assert_eq!(d.on_action(&Action::Send), Outcome::Close);
        d.on_action(&Action::Right);
        assert_eq!(d.on_action(&Action::Send), Outcome::Run("do.it".into()));
        assert_eq!(d.on_action(&Action::Cancel), Outcome::Close);
        // ボタン幅 = ラベル幅 + 4（"[ " と " ]"）。間は 1 桁
        let Modal::Dialog(inner) = &d else { panic!() };
        assert_eq!(inner.button_spans(), [(0, 10), (11, 19)]);
        assert_eq!(d.on_click(3, 12, 2), Outcome::Run("do.it".into()));
        assert_eq!(d.on_click(2, 12, 2), Outcome::Keep);
    }

    #[test]
    fn choice_returns_the_selected_value_and_prompt_the_typed_text() {
        let mut c = Modal::Choice(Choice::new(
            "c",
            "pref.set",
            vec!["a".into(), "b".into()],
            1,
        ));
        assert_eq!(
            c.on_action(&Action::Send),
            Outcome::Submit("pref.set".into(), "b".into())
        );
        let mut p = Modal::Prompt(Prompt {
            title: "p".into(),
            command: "react".into(),
            text: TextBuf::default(),
        });
        p.on_action(&Action::Insert('🔥'));
        p.on_action(&Action::Insert('x'));
        p.on_action(&Action::Backspace);
        assert_eq!(
            p.on_action(&Action::Send),
            Outcome::Submit("react".into(), "🔥".into())
        );
    }
}
