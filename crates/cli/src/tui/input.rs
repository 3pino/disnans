//! キー入力を操作へ変える。Enter の動作はサーバーの `enterKeys`（GUI と共通）に従う。

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnterAction {
    Send,
    Newline,
    None,
}

/// Enter と修飾キーの組み合わせごとの動作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnterKeys {
    pub enter: EnterAction,
    pub shift: EnterAction,
    pub ctrl: EnterAction,
    pub alt: EnterAction,
}

impl Default for EnterKeys {
    /// GUI の既定と同じ。prefs を読めるまで・読めなかったときにも使う。
    fn default() -> Self {
        Self {
            enter: EnterAction::Newline,
            shift: EnterAction::Newline,
            ctrl: EnterAction::Send,
            alt: EnterAction::Send,
        }
    }
}

impl EnterKeys {
    /// `GET /api/me/prefs` の値から読む。読めない項目は既定のまま。
    pub fn from_prefs(prefs: &Value) -> Self {
        let mut keys = Self::default();
        let Some(raw) = prefs.get("enterKeys").and_then(Value::as_object) else {
            return keys;
        };
        let read = |name: &str, slot: &mut EnterAction| {
            if let Some(action) = raw.get(name).and_then(Value::as_str) {
                *slot = match action {
                    "send" => EnterAction::Send,
                    "newline" => EnterAction::Newline,
                    "none" => EnterAction::None,
                    _ => *slot,
                };
            }
        };
        read("enter", &mut keys.enter);
        read("shift", &mut keys.shift);
        read("ctrl", &mut keys.ctrl);
        read("alt", &mut keys.alt);
        keys
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Quit,
    Send,
    Newline,
    Insert(char),
    Backspace,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    ScrollUp,
    ScrollDown,
    ScrollTop,
    ScrollBottom,
    Refetch,
    /// Tab: 送信ボタンへ。
    FocusButton,
    /// Shift+Tab: 入力欄へ戻る。
    FocusInput,
    Ignore,
}

/// 端末がキー修飾を区別して送れるかと、サーバー設定をまとめたもの。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keymap {
    pub enter_keys: EnterKeys,
    /// kitty のキー拡張などで Shift+Enter / Ctrl+Enter を区別できる。
    pub enhanced: bool,
}

impl Keymap {
    pub fn new(enter_keys: EnterKeys, enhanced: bool) -> Self {
        Self {
            enter_keys,
            enhanced,
        }
    }

    pub fn map(&self, key: KeyEvent) -> Action {
        // Windows などで来る離したときのイベントは無視する。
        if key.kind == KeyEventKind::Release {
            return Action::Ignore;
        }
        let mods = key.modifiers;
        let ctrl = mods.contains(KeyModifiers::CONTROL);
        let alt = mods.contains(KeyModifiers::ALT);
        let shift = mods.contains(KeyModifiers::SHIFT);
        let sup = mods.contains(KeyModifiers::SUPER);
        match key.code {
            KeyCode::Enter => self.enter(ctrl || sup, alt, shift),
            KeyCode::Char(c) if ctrl && !alt => match c.to_ascii_lowercase() {
                'q' | 'c' => Action::Quit,
                // 端末や設定に関わらず送れる・改行できる固定のキー。
                's' => Action::Send,
                'j' => Action::Newline,
                'r' => Action::Refetch,
                _ => Action::Ignore,
            },
            // AltGr（Ctrl+Alt）で入る文字は通常の入力として受ける。
            KeyCode::Char(c) if ctrl && alt => Action::Insert(c),
            KeyCode::Char(_) if alt || ctrl => Action::Ignore,
            KeyCode::Char(c) => Action::Insert(c),
            KeyCode::Tab if !ctrl && !alt => Action::FocusButton,
            KeyCode::BackTab => Action::FocusInput,
            KeyCode::Backspace => Action::Backspace,
            KeyCode::Delete => Action::Delete,
            KeyCode::Left => Action::Left,
            KeyCode::Right => Action::Right,
            KeyCode::Up if alt => Action::ScrollUp,
            KeyCode::Down if alt => Action::ScrollDown,
            KeyCode::Up => Action::Up,
            KeyCode::Down => Action::Down,
            KeyCode::Home if ctrl => Action::ScrollTop,
            KeyCode::End if ctrl => Action::ScrollBottom,
            KeyCode::Home => Action::Home,
            KeyCode::End => Action::End,
            KeyCode::PageUp => Action::PageUp,
            KeyCode::PageDown => Action::PageDown,
            _ => Action::Ignore,
        }
    }

    fn enter(&self, ctrl: bool, alt: bool, shift: bool) -> Action {
        let count = [ctrl, alt, shift].into_iter().filter(|m| *m).count();
        let action = match (count, ctrl, alt, shift) {
            (0, ..) => self.enter_keys.enter,
            (1, true, ..) => self.enter_keys.ctrl,
            (1, _, true, _) => self.enter_keys.alt,
            (1, _, _, true) => self.enter_keys.shift,
            // 修飾キーを2つ以上押しているときは何もしない（GUI と同じ）。
            _ => EnterAction::None,
        };
        match action {
            EnterAction::Send => Action::Send,
            EnterAction::Newline => Action::Newline,
            EnterAction::None => Action::Ignore,
        }
    }

    /// 入力欄の下に出すキーの案内。端末が区別できない組み合わせは載せない。
    pub fn hint(&self) -> String {
        let keys = &self.enter_keys;
        let mut combos = vec![("Enter", keys.enter), ("Alt+Enter", keys.alt)];
        if self.enhanced {
            combos.insert(1, ("Shift+Enter", keys.shift));
            combos.insert(2, ("Ctrl+Enter", keys.ctrl));
        }
        let pick = |wanted: EnterAction, fixed: &str| {
            let mut names: Vec<&str> = combos
                .iter()
                .filter(|(_, action)| *action == wanted)
                .map(|(name, _)| *name)
                .collect();
            names.push(fixed);
            names.join("/")
        };
        format!(
            "送信: {} | 改行: {} | Tab: 送信ボタン | PgUp/PgDn: 履歴 | Ctrl+Q: 終了",
            pick(EnterAction::Send, "Ctrl+S"),
            pick(EnterAction::Newline, "Ctrl+J"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }

    fn map(keys: EnterKeys, code: KeyCode, mods: KeyModifiers) -> Action {
        Keymap::new(keys, true).map(key(code, mods))
    }

    #[test]
    fn default_enter_keys_match_the_gui() {
        let keys = EnterKeys::default();
        assert_eq!(
            map(keys, KeyCode::Enter, KeyModifiers::NONE),
            Action::Newline
        );
        assert_eq!(
            map(keys, KeyCode::Enter, KeyModifiers::SHIFT),
            Action::Newline
        );
        assert_eq!(
            map(keys, KeyCode::Enter, KeyModifiers::CONTROL),
            Action::Send
        );
        assert_eq!(map(keys, KeyCode::Enter, KeyModifiers::SUPER), Action::Send);
        assert_eq!(map(keys, KeyCode::Enter, KeyModifiers::ALT), Action::Send);
    }

    #[test]
    fn every_enter_combination_follows_the_configured_action() {
        for (name, mods) in [
            ("enter", KeyModifiers::NONE),
            ("shift", KeyModifiers::SHIFT),
            ("ctrl", KeyModifiers::CONTROL),
            ("alt", KeyModifiers::ALT),
        ] {
            for (setting, expected) in [
                ("send", Action::Send),
                ("newline", Action::Newline),
                ("none", Action::Ignore),
            ] {
                let keys = EnterKeys::from_prefs(&json!({"enterKeys": {name: setting}}));
                assert_eq!(
                    map(keys, KeyCode::Enter, mods),
                    expected,
                    "{name}={setting}"
                );
            }
        }
    }

    #[test]
    fn two_modifiers_on_enter_do_nothing() {
        let keys = EnterKeys::from_prefs(&json!({"enterKeys": {"ctrl": "send", "shift": "send"}}));
        assert_eq!(
            map(
                keys,
                KeyCode::Enter,
                KeyModifiers::CONTROL | KeyModifiers::SHIFT
            ),
            Action::Ignore
        );
    }

    #[test]
    fn invalid_prefs_fall_back_to_defaults_per_field() {
        assert_eq!(EnterKeys::from_prefs(&json!({})), EnterKeys::default());
        assert_eq!(EnterKeys::from_prefs(&json!(null)), EnterKeys::default());
        assert_eq!(
            EnterKeys::from_prefs(&json!({"enterKeys": 3})),
            EnterKeys::default()
        );
        let keys = EnterKeys::from_prefs(
            &json!({"enterKeys": {"enter": "send", "ctrl": "bogus", "alt": 7}}),
        );
        assert_eq!(keys.enter, EnterAction::Send);
        assert_eq!(keys.ctrl, EnterAction::Send);
        assert_eq!(keys.alt, EnterAction::Send);
        assert_eq!(keys.shift, EnterAction::Newline);
    }

    #[test]
    fn fixed_keys_work_whatever_the_prefs_say() {
        let none = EnterKeys {
            enter: EnterAction::None,
            shift: EnterAction::None,
            ctrl: EnterAction::None,
            alt: EnterAction::None,
        };
        assert_eq!(
            map(none, KeyCode::Char('s'), KeyModifiers::CONTROL),
            Action::Send
        );
        assert_eq!(
            map(none, KeyCode::Char('j'), KeyModifiers::CONTROL),
            Action::Newline
        );
        assert_eq!(
            map(none, KeyCode::Char('q'), KeyModifiers::CONTROL),
            Action::Quit
        );
        assert_eq!(
            map(none, KeyCode::Char('c'), KeyModifiers::CONTROL),
            Action::Quit
        );
        assert_eq!(
            map(
                none,
                KeyCode::Char('C'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT
            ),
            Action::Quit
        );
    }

    #[test]
    fn typing_inserts_but_other_modified_characters_do_not() {
        let keys = EnterKeys::default();
        assert_eq!(
            map(keys, KeyCode::Char('a'), KeyModifiers::NONE),
            Action::Insert('a')
        );
        assert_eq!(
            map(keys, KeyCode::Char('A'), KeyModifiers::SHIFT),
            Action::Insert('A')
        );
        assert_eq!(
            map(keys, KeyCode::Char('あ'), KeyModifiers::NONE),
            Action::Insert('あ')
        );
        assert_eq!(
            map(keys, KeyCode::Char('x'), KeyModifiers::ALT),
            Action::Ignore
        );
        assert_eq!(
            map(keys, KeyCode::Char('x'), KeyModifiers::CONTROL),
            Action::Ignore
        );
        // AltGr は Ctrl+Alt として届くことがある。
        assert_eq!(
            map(
                keys,
                KeyCode::Char('@'),
                KeyModifiers::CONTROL | KeyModifiers::ALT
            ),
            Action::Insert('@')
        );
    }

    #[test]
    fn release_events_are_ignored() {
        let mut event = key(KeyCode::Char('a'), KeyModifiers::NONE);
        event.kind = KeyEventKind::Release;
        assert_eq!(
            Keymap::new(EnterKeys::default(), true).map(event),
            Action::Ignore
        );
    }

    #[test]
    fn scrolling_and_cursor_keys() {
        let keys = EnterKeys::default();
        assert_eq!(
            map(keys, KeyCode::PageUp, KeyModifiers::NONE),
            Action::PageUp
        );
        assert_eq!(
            map(keys, KeyCode::PageDown, KeyModifiers::NONE),
            Action::PageDown
        );
        assert_eq!(map(keys, KeyCode::Up, KeyModifiers::ALT), Action::ScrollUp);
        assert_eq!(map(keys, KeyCode::Up, KeyModifiers::NONE), Action::Up);
        assert_eq!(
            map(keys, KeyCode::Home, KeyModifiers::CONTROL),
            Action::ScrollTop
        );
        assert_eq!(
            map(keys, KeyCode::End, KeyModifiers::CONTROL),
            Action::ScrollBottom
        );
        assert_eq!(map(keys, KeyCode::Home, KeyModifiers::NONE), Action::Home);
        assert_eq!(
            map(keys, KeyCode::Char('r'), KeyModifiers::CONTROL),
            Action::Refetch
        );
        assert_eq!(map(keys, KeyCode::Esc, KeyModifiers::NONE), Action::Ignore);
    }

    #[test]
    fn hints_only_list_combinations_the_terminal_can_send() {
        let plain = Keymap::new(EnterKeys::default(), false).hint();
        assert!(plain.contains("送信: Alt+Enter/Ctrl+S"), "{plain}");
        assert!(!plain.contains("Shift+Enter"));
        assert!(!plain.contains("Ctrl+Enter"));
        let enhanced = Keymap::new(EnterKeys::default(), true).hint();
        assert!(
            enhanced.contains("送信: Ctrl+Enter/Alt+Enter/Ctrl+S"),
            "{enhanced}"
        );
        assert!(
            enhanced.contains("改行: Enter/Shift+Enter/Ctrl+J"),
            "{enhanced}"
        );
    }
}
