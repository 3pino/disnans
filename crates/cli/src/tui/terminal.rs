//! 端末の準備と、終了・異常終了時の確実な復元。

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
    supports_keyboard_enhancement,
};

/// 復元の各操作。テストで順序を確かめるため抽象化している。
pub trait TermOps {
    fn pop_keyboard_flags(&mut self) -> io::Result<()>;
    fn disable_paste(&mut self) -> io::Result<()>;
    fn leave_screen(&mut self) -> io::Result<()>;
    fn show_cursor(&mut self) -> io::Result<()>;
    fn disable_raw(&mut self) -> io::Result<()>;
}

/// 有効化と逆の順に戻す。1つ失敗しても残りは続ける。
pub fn restore_with(ops: &mut impl TermOps, keyboard_flags_pushed: bool) {
    if keyboard_flags_pushed {
        let _ = ops.pop_keyboard_flags();
    }
    let _ = ops.disable_paste();
    let _ = ops.leave_screen();
    let _ = ops.show_cursor();
    let _ = ops.disable_raw();
}

struct RealOps;

impl TermOps for RealOps {
    fn pop_keyboard_flags(&mut self) -> io::Result<()> {
        execute!(io::stdout(), PopKeyboardEnhancementFlags)
    }
    fn disable_paste(&mut self) -> io::Result<()> {
        execute!(io::stdout(), DisableBracketedPaste)
    }
    fn leave_screen(&mut self) -> io::Result<()> {
        execute!(io::stdout(), LeaveAlternateScreen)
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        execute!(io::stdout(), crossterm::cursor::Show)
    }
    fn disable_raw(&mut self) -> io::Result<()> {
        disable_raw_mode()
    }
}

/// 端末が有効化済みで、まだ戻していない間 true。
static ACTIVE: AtomicBool = AtomicBool::new(false);
static KEYBOARD_FLAGS: AtomicBool = AtomicBool::new(false);

/// 一度だけ復元する（Drop・panic・シグナルのどこから呼んでもよい）。
pub fn restore() {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        restore_with(&mut RealOps, KEYBOARD_FLAGS.load(Ordering::SeqCst));
        let _ = io::stdout().flush();
    }
}

pub struct TerminalGuard {
    /// Shift+Enter / Ctrl+Enter を区別して受け取れる。
    pub enhanced_keys: bool,
}

impl TerminalGuard {
    pub fn enter() -> io::Result<Self> {
        install_panic_hook();
        enable_raw_mode()?;
        ACTIVE.store(true, Ordering::SeqCst);
        let result = (|| {
            execute!(io::stdout(), EnterAlternateScreen, EnableBracketedPaste)?;
            // 対応端末では修飾付き Enter を区別できる。Windows のコンソールは元から区別できる。
            let mut enhanced = cfg!(windows);
            if supports_keyboard_enhancement().unwrap_or(false)
                && execute!(
                    io::stdout(),
                    PushKeyboardEnhancementFlags(
                        KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                    )
                )
                .is_ok()
            {
                KEYBOARD_FLAGS.store(true, Ordering::SeqCst);
                enhanced = true;
            }
            Ok(enhanced)
        })();
        match result {
            Ok(enhanced_keys) => Ok(Self { enhanced_keys }),
            Err(e) => {
                restore();
                Err(e)
            }
        }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

/// panic の前に端末を戻し、元のフックでメッセージを出す。
fn install_panic_hook() {
    static INSTALLED: AtomicBool = AtomicBool::new(false);
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let original = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        original(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        calls: Vec<&'static str>,
        fail: Option<&'static str>,
    }

    impl Recorder {
        fn record(&mut self, name: &'static str) -> io::Result<()> {
            self.calls.push(name);
            if self.fail == Some(name) {
                Err(io::Error::other("x"))
            } else {
                Ok(())
            }
        }
    }

    impl TermOps for Recorder {
        fn pop_keyboard_flags(&mut self) -> io::Result<()> {
            self.record("pop")
        }
        fn disable_paste(&mut self) -> io::Result<()> {
            self.record("paste")
        }
        fn leave_screen(&mut self) -> io::Result<()> {
            self.record("leave")
        }
        fn show_cursor(&mut self) -> io::Result<()> {
            self.record("cursor")
        }
        fn disable_raw(&mut self) -> io::Result<()> {
            self.record("raw")
        }
    }

    #[test]
    fn restores_in_reverse_order_of_setup() {
        let mut ops = Recorder::default();
        restore_with(&mut ops, true);
        assert_eq!(ops.calls, ["pop", "paste", "leave", "cursor", "raw"]);
        let mut ops = Recorder::default();
        restore_with(&mut ops, false);
        assert_eq!(ops.calls, ["paste", "leave", "cursor", "raw"]);
    }

    #[test]
    fn a_failing_step_does_not_stop_the_rest() {
        let mut ops = Recorder {
            fail: Some("leave"),
            ..Recorder::default()
        };
        restore_with(&mut ops, false);
        assert_eq!(ops.calls.last(), Some(&"raw"));
        assert_eq!(ops.calls.len(), 4);
    }
}
