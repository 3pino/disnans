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
    /// 検索（語の入力・結果の選択）。
    Search,
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
/// 検索を開く（入力欄・選択モードの Ctrl+F、選択モードの `/`）。
pub const SEARCH_OPEN: &str = "search.open";
/// 検索を閉じて入力欄へ戻る。
pub const SEARCH_CLOSE: &str = "search.close";
/// 絵文字の入力を始める。
pub const MESSAGE_REACT: &str = "message.react";
pub const MESSAGE_REACT_APPLY: &str = "message.react.apply";
/// 選んだメッセージの操作メニューを開く。
/// 設定画面を開く。
pub const SETTINGS_OPEN: &str = "settings.open";
pub const MESSAGE_MENU: &str = "message.menu";
/// 結果が不明だった送信を、確認のうえで改めて送る。
pub const CHAT_RESEND_CONFIRMED: &str = "chat.resend.confirmed";
pub const CHAT_RESEND_CONFIRMED_SILENT: &str = "chat.resend.confirmed.silent";
/// すぐ付け外しする絵文字（選択モードの数字キー 1〜5）。
pub const QUICK_REACTIONS: [(&str, &str); 5] = [
    ("message.react.quick.1", "👍"),
    ("message.react.quick.2", "🎉"),
    ("message.react.quick.3", "😂"),
    ("message.react.quick.4", "😮"),
    ("message.react.quick.5", "🙏"),
];

pub const MODE_NAMES: [(&str, Mode); 2] = [("input", Mode::Input), ("select", Mode::Select)];

/// 設定のキー名（`j`・`Down`・`Enter`・`Esc`・`Ctrl+F`・`Alt+Enter` など）を操作にする。読めなければ `None`。
/// Enter は、入力欄の設定に関わらず「送る」「改行」のどちらの操作にも当たる。
pub fn parse_keys(name: &str) -> Option<Vec<Action>> {
    let one = |a| Some(vec![a]);
    match name.trim().to_lowercase().as_str() {
        "up" => one(Action::Up),
        "down" => one(Action::Down),
        "left" => one(Action::Left),
        "right" => one(Action::Right),
        "home" => one(Action::Home),
        "end" => one(Action::End),
        "pageup" => one(Action::PageUp),
        "pagedown" => one(Action::PageDown),
        "esc" | "escape" => one(Action::Cancel),
        "enter" => Some(vec![Action::Send, Action::Newline]),
        "alt+enter" => one(Action::SendSilent),
        "ctrl+f" => one(Action::Search),
        _ => {
            let mut chars = name.trim().chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if !c.is_control() && !c.is_whitespace() => one(Action::Insert(c)),
                _ => None,
            }
        }
    }
}

/// `parse_keys` の逆（設定への保存・表示用）。名前の無い操作は `None`。
pub fn key_name(action: &Action) -> Option<String> {
    Some(match action {
        Action::Insert(c) => c.to_string(),
        Action::Up => "Up".into(),
        Action::Down => "Down".into(),
        Action::Left => "Left".into(),
        Action::Right => "Right".into(),
        Action::Home => "Home".into(),
        Action::End => "End".into(),
        Action::PageUp => "PageUp".into(),
        Action::PageDown => "PageDown".into(),
        Action::Cancel => "Esc".into(),
        Action::Send | Action::Newline => "Enter".into(),
        Action::SendSilent => "Alt+Enter".into(),
        Action::Search => "Ctrl+F".into(),
        _ => return None,
    })
}

/// モードごとの操作（キー）とコマンドの対応表。後から利用者の設定で差し替えられるよう、データとして持つ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bindings(Vec<(Mode, Action, &'static str)>);

impl Default for Bindings {
    fn default() -> Self {
        use Action::*;
        let mut table = vec![
            (Mode::Input, Send, CHAT_SEND),
            (Mode::Input, SendSilent, CHAT_SEND_SILENT),
            (Mode::Input, Action::Search, SEARCH_OPEN),
            (Mode::Input, Cancel, MESSAGE_SELECT),
            (Mode::Select, Up, MESSAGE_SELECT_PREV),
            (Mode::Select, Insert('k'), MESSAGE_SELECT_PREV),
            (Mode::Select, Down, MESSAGE_SELECT_NEXT),
            (Mode::Select, Insert('j'), MESSAGE_SELECT_NEXT),
            (Mode::Select, Cancel, MESSAGE_SELECT_CANCEL),
            (Mode::Select, Action::Search, SEARCH_OPEN),
            (Mode::Select, Insert('/'), SEARCH_OPEN),
            (Mode::Select, Left, MESSAGE_IMAGES_PREV),
            (Mode::Select, Insert('h'), MESSAGE_IMAGES_PREV),
            (Mode::Select, Right, MESSAGE_IMAGES_NEXT),
            (Mode::Select, Insert('l'), MESSAGE_IMAGES_NEXT),
            (Mode::Select, Insert('r'), MESSAGE_REACT),
            (Mode::Select, Insert('m'), MESSAGE_MENU),
            (Mode::Select, Insert('p'), MESSAGE_REPLY),
            (Mode::Select, Send, MESSAGE_REPLY),
            (Mode::Select, Newline, MESSAGE_REPLY),
        ];
        for (i, (command, _)) in QUICK_REACTIONS.iter().enumerate() {
            table.push((Mode::Select, Insert((b'1' + i as u8) as char), *command));
        }
        Self(table)
    }
}

impl Bindings {
    /// キーの操作を、そのモードでのコマンド ID にする。対応が無ければ `None`。
    /// 入力欄の Esc は、返信先があれば返信の取消、なければ選択モードへ。
    pub fn command(&self, mode: Mode, action: &Action, has_reply: bool) -> Option<&'static str> {
        // 検索の中のキーは、段階（入力・結果）で違うので app.rs が決める。
        let found = self
            .0
            .iter()
            .find(|(m, a, _)| *m == mode && a == action)
            .map(|(_, _, c)| *c);
        match found {
            Some(MESSAGE_SELECT) if has_reply => Some(MESSAGE_REPLY_CANCEL),
            other => other,
        }
    }

    /// キーの割り当てを足す（同じモード・キーの既存の割り当ては置き換える）。
    pub fn rebind(&mut self, mode: Mode, action: Action, command: &'static str) {
        self.0.retain(|(m, a, _)| !(*m == mode && *a == action));
        self.0.push((mode, action, command));
    }

    /// コマンドのキーをまとめて置き換える（空なら、そのコマンドのキーは無くなる）。
    pub fn set_keys(&mut self, mode: Mode, command: &'static str, keys: Vec<Action>) {
        self.0.retain(|(m, _, c)| !(*m == mode && *c == command));
        for key in keys {
            self.rebind(mode, key, command);
        }
    }

    /// 既定の表にあるコマンド ID（文字列を `'static` にそろえる）。
    pub fn known(command: &str) -> Option<&'static str> {
        Self::default()
            .0
            .iter()
            .map(|(_, _, c)| *c)
            .find(|c| *c == command)
    }

    /// 設定（`{"select": {"コマンド ID": ["j", "Down"]}}`）を重ねる。読めない項目は飛ばし、理由を返す。
    pub fn apply_overrides(&mut self, value: &serde_json::Value) -> Vec<String> {
        let mut warnings = Vec::new();
        for (mode_name, mode) in MODE_NAMES {
            let Some(map) = value.get(mode_name).and_then(|v| v.as_object()) else {
                continue;
            };
            for (command, keys) in map {
                let Some(id) = Self::known(command) else {
                    warnings.push(format!("未知のコマンド: {command}"));
                    continue;
                };
                let parsed: Option<Vec<Action>> = keys.as_array().and_then(|list| {
                    list.iter()
                        .map(|k| k.as_str().and_then(parse_keys))
                        .collect::<Option<Vec<_>>>()
                        .map(|v| v.into_iter().flatten().collect())
                });
                match parsed {
                    Some(keys) => self.set_keys(mode, id, keys),
                    None => warnings.push(format!("読めないキー: {command}")),
                }
            }
        }
        warnings
    }

    /// コマンドに割り当てたキー（ヒントの表示用）。
    pub fn keys_for(&self, mode: Mode, command: &str) -> Vec<&Action> {
        self.0
            .iter()
            .filter(|(m, _, c)| *m == mode && *c == command)
            .map(|(_, a, _)| a)
            .collect()
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
        let b = Bindings::default();
        assert_eq!(
            b.command(Mode::Input, &Action::Cancel, false),
            Some(MESSAGE_SELECT)
        );
        assert_eq!(
            b.command(Mode::Input, &Action::Cancel, true),
            Some(MESSAGE_REPLY_CANCEL)
        );
        assert_eq!(
            b.command(Mode::Input, &Action::SendSilent, false),
            Some(CHAT_SEND_SILENT)
        );
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('j'), false),
            Some(MESSAGE_SELECT_NEXT)
        );
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('3'), false),
            Some("message.react.quick.3")
        );
        assert_eq!(b.command(Mode::Select, &Action::Insert('z'), false), None);
        assert_eq!(
            b.command(Mode::Select, &Action::Left, false),
            Some(MESSAGE_IMAGES_PREV)
        );
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('l'), false),
            Some(MESSAGE_IMAGES_NEXT)
        );
    }

    #[test]
    fn overrides_replace_keys_and_skip_unreadable_entries() {
        let mut b = Bindings::default();
        let warnings = b.apply_overrides(&serde_json::json!({
            "select": {
                "message.select.next": ["n", "Down", "Enter"],
                "message.react": ["???"],
                "nope": ["x"]
            }
        }));
        assert_eq!(warnings.len(), 2);
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('n'), false),
            Some(MESSAGE_SELECT_NEXT)
        );
        // 元の j は外れ、読めなかった react の割り当ては残る
        assert_eq!(b.command(Mode::Select, &Action::Insert('j'), false), None);
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('r'), false),
            Some(MESSAGE_REACT)
        );
        assert_eq!(key_name(&Action::Send).as_deref(), Some("Enter"));
        assert_eq!(parse_keys("Ctrl+F"), Some(vec![Action::Search]));
        assert_eq!(parse_keys("ab"), None);
    }

    #[test]
    fn bindings_can_be_rebound_and_report_their_keys_for_hints() {
        let mut b = Bindings::default();
        assert_eq!(
            b.keys_for(Mode::Select, MESSAGE_SELECT_NEXT),
            [&Action::Down, &Action::Insert('j')]
        );
        b.rebind(Mode::Select, Action::Insert('d'), MESSAGE_SELECT_NEXT);
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('d'), false),
            Some(MESSAGE_SELECT_NEXT)
        );
        // 同じキーの割り当ては置き換わる
        b.rebind(Mode::Select, Action::Insert('j'), MESSAGE_REACT);
        assert_eq!(
            b.command(Mode::Select, &Action::Insert('j'), false),
            Some(MESSAGE_REACT)
        );
    }
}
