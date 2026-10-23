//! TUI の操作（コマンド）の ID。キーとの対応はここ 1 か所に置く。
//!
//! ID は文字列（`message.react` など）。後で client-core の commands（V5）へ寄せるときも、この文字列を使う。

use super::input::Action;

/// 画面の操作モード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 入力欄（通常）。
    Input,
    /// メッセージを上下で選んでいる。
    Select,
    /// 選んだメッセージへのリアクションの絵文字を入力している。
    React,
}

pub const CHAT_SEND: &str = "chat.send";
pub const CHAT_SEND_SILENT: &str = "chat.send.silent";
/// 選択モードに入る。
pub const MESSAGE_SELECT: &str = "message.select";
pub const MESSAGE_SELECT_PREV: &str = "message.select.prev";
pub const MESSAGE_SELECT_NEXT: &str = "message.select.next";
pub const MESSAGE_SELECT_CANCEL: &str = "message.select.cancel";
/// 選んだメッセージへ返信する（入力欄へ戻り、返信先を付ける）。
pub const MESSAGE_REPLY: &str = "message.reply";
pub const MESSAGE_REPLY_CANCEL: &str = "message.reply.cancel";
/// 選んだメッセージの画像の帯を左右へ 1 枚ずつ動かす。
pub const MESSAGE_IMAGES_PREV: &str = "message.images.prev";
pub const MESSAGE_IMAGES_NEXT: &str = "message.images.next";
/// 絵文字の入力を始める。
pub const MESSAGE_REACT: &str = "message.react";
pub const MESSAGE_REACT_APPLY: &str = "message.react.apply";
pub const MESSAGE_REACT_CANCEL: &str = "message.react.cancel";
/// すぐ付け外しする絵文字（選択モードの数字キー 1〜5）。
pub const QUICK_REACTIONS: [(&str, &str); 5] = [
    ("message.react.quick.1", "👍"),
    ("message.react.quick.2", "🎉"),
    ("message.react.quick.3", "😂"),
    ("message.react.quick.4", "😮"),
    ("message.react.quick.5", "🙏"),
];

/// キーの操作を、そのモードでのコマンド ID にする。対応が無ければ `None`。
pub fn from_key(mode: Mode, action: &Action, has_reply: bool) -> Option<&'static str> {
    match mode {
        Mode::Input => match action {
            Action::Send => Some(CHAT_SEND),
            Action::SendSilent => Some(CHAT_SEND_SILENT),
            Action::Cancel if has_reply => Some(MESSAGE_REPLY_CANCEL),
            Action::Cancel => Some(MESSAGE_SELECT),
            _ => None,
        },
        Mode::Select => match action {
            Action::Up | Action::Insert('k') => Some(MESSAGE_SELECT_PREV),
            Action::Down | Action::Insert('j') => Some(MESSAGE_SELECT_NEXT),
            Action::Cancel => Some(MESSAGE_SELECT_CANCEL),
            Action::Left | Action::Insert('h') => Some(MESSAGE_IMAGES_PREV),
            Action::Right | Action::Insert('l') => Some(MESSAGE_IMAGES_NEXT),
            Action::Insert('r') => Some(MESSAGE_REACT),
            Action::Insert('p') | Action::Send | Action::Newline => Some(MESSAGE_REPLY),
            Action::Insert(c @ '1'..='5') => Some(QUICK_REACTIONS[usize::from(*c as u8 - b'1')].0),
            _ => None,
        },
        Mode::React => match action {
            Action::Cancel => Some(MESSAGE_REACT_CANCEL),
            Action::Send | Action::Newline => Some(MESSAGE_REACT_APPLY),
            _ => None,
        },
    }
}

/// 選択モードでのスクロールなど、入力欄のモードの処理へそのまま渡してよい操作か。
pub fn is_passthrough(action: &Action) -> bool {
    matches!(
        action,
        Action::Quit
            | Action::PageUp
            | Action::PageDown
            | Action::ScrollUp
            | Action::ScrollDown
            | Action::ScrollTop
            | Action::ScrollBottom
            | Action::Refetch
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_command_ids_per_mode() {
        assert_eq!(
            from_key(Mode::Input, &Action::Cancel, false),
            Some(MESSAGE_SELECT)
        );
        assert_eq!(
            from_key(Mode::Input, &Action::Cancel, true),
            Some(MESSAGE_REPLY_CANCEL)
        );
        assert_eq!(
            from_key(Mode::Input, &Action::SendSilent, false),
            Some(CHAT_SEND_SILENT)
        );
        assert_eq!(
            from_key(Mode::Select, &Action::Insert('j'), false),
            Some(MESSAGE_SELECT_NEXT)
        );
        assert_eq!(
            from_key(Mode::Select, &Action::Insert('3'), false),
            Some("message.react.quick.3")
        );
        assert_eq!(from_key(Mode::Select, &Action::Insert('z'), false), None);
        assert_eq!(
            from_key(Mode::Select, &Action::Left, false),
            Some(MESSAGE_IMAGES_PREV)
        );
        assert_eq!(
            from_key(Mode::Select, &Action::Insert('l'), false),
            Some(MESSAGE_IMAGES_NEXT)
        );
        assert_eq!(
            from_key(Mode::React, &Action::Newline, false),
            Some(MESSAGE_REACT_APPLY)
        );
        assert_eq!(from_key(Mode::React, &Action::Insert('r'), false), None);
    }
}
