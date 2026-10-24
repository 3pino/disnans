//! 複数行の入力バッファ。カーソルは文字（char）単位で動かす。

use super::sanitize;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TextBuf {
    text: String,
    /// `text` 内のバイト位置（常に文字境界）。
    cursor: usize,
    /// 上下移動で保つ桁（文字数）。
    goal_column: Option<usize>,
}

impl TextBuf {
    pub fn from_text(text: &str) -> Self {
        let text = clean(text);
        let cursor = text.len();
        Self {
            text,
            cursor,
            goal_column: None,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.goal_column = None;
    }

    /// カーソルより前の文字列。
    pub fn before_cursor(&self) -> &str {
        &self.text[..self.cursor]
    }

    /// カーソル直前の `chars` 文字を `with` に置き換える。
    pub fn replace_before_cursor(&mut self, chars: usize, with: &str) {
        let start = self.text[..self.cursor]
            .char_indices()
            .rev()
            .nth(chars.saturating_sub(1))
            .map_or(0, |(i, _)| i);
        self.text.replace_range(start..self.cursor, &clean(with));
        self.cursor = start + clean(with).len();
        self.goal_column = None;
    }

    /// カーソルの（論理行, その行の先頭からの文字数）。
    pub fn cursor_position(&self) -> (usize, usize) {
        let before = &self.text[..self.cursor];
        let row = before.matches('\n').count();
        let column = before
            .rsplit('\n')
            .next()
            .map_or(0, |line| line.chars().count());
        (row, column)
    }

    pub fn insert_str(&mut self, input: &str) {
        let cleaned = clean(input);
        self.text.insert_str(self.cursor, &cleaned);
        self.cursor += cleaned.len();
        self.goal_column = None;
    }

    pub fn insert_char(&mut self, c: char) {
        let mut buf = [0; 4];
        self.insert_str(c.encode_utf8(&mut buf));
    }

    pub fn newline(&mut self) {
        self.insert_str("\n");
    }

    pub fn backspace(&mut self) {
        if let Some(c) = self.text[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
            self.text.remove(self.cursor);
        }
        self.goal_column = None;
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            self.text.remove(self.cursor);
        }
        self.goal_column = None;
    }

    pub fn left(&mut self) {
        if let Some(c) = self.text[..self.cursor].chars().next_back() {
            self.cursor -= c.len_utf8();
        }
        self.goal_column = None;
    }

    pub fn right(&mut self) {
        if let Some(c) = self.text[self.cursor..].chars().next() {
            self.cursor += c.len_utf8();
        }
        self.goal_column = None;
    }

    pub fn home(&mut self) {
        self.cursor = self.line_start(self.cursor);
        self.goal_column = None;
    }

    pub fn end(&mut self) {
        self.cursor = self.line_end(self.cursor);
        self.goal_column = None;
    }

    pub fn up(&mut self) {
        let start = self.line_start(self.cursor);
        if start == 0 {
            return;
        }
        let column = self.goal_column.unwrap_or_else(|| self.cursor_position().1);
        let prev_start = self.line_start(start - 1);
        self.cursor = self.move_to_column(prev_start, start - 1, column);
        self.goal_column = Some(column);
    }

    pub fn down(&mut self) {
        let end = self.line_end(self.cursor);
        if end >= self.text.len() {
            return;
        }
        let column = self.goal_column.unwrap_or_else(|| self.cursor_position().1);
        let next_start = end + 1;
        let next_end = self.line_end(next_start);
        self.cursor = self.move_to_column(next_start, next_end, column);
        self.goal_column = Some(column);
    }

    fn line_start(&self, pos: usize) -> usize {
        self.text[..pos].rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self, pos: usize) -> usize {
        self.text[pos..]
            .find('\n')
            .map_or(self.text.len(), |i| pos + i)
    }

    fn move_to_column(&self, start: usize, end: usize, column: usize) -> usize {
        let line = &self.text[start..end];
        let offset: usize = line.chars().take(column).map(char::len_utf8).sum();
        start + offset
    }

    /// 表示幅 `width` 桁で折り返した行と、カーソルの（行, 桁）。
    /// 返す文字列はターミナルに渡す前にエスケープ済み。
    pub fn layout(&self, width: usize) -> (Vec<String>, (usize, usize)) {
        let width = width.max(1);
        let (cursor_row, cursor_col) = self.cursor_position();
        let mut rows = Vec::new();
        let mut cursor = (0, 0);
        for (index, line) in self.text.split('\n').enumerate() {
            let on_cursor_line = index == cursor_row;
            let mut current = String::new();
            let mut used = 0;
            let mut row_index = rows.len();
            let mut count = 0;
            for (char_index, c) in line.chars().enumerate() {
                let cell = display_char(c);
                let w = sanitize::display_width(&cell);
                if used + w > width && used > 0 {
                    rows.push(std::mem::take(&mut current));
                    row_index += 1;
                    used = 0;
                }
                if on_cursor_line && char_index == cursor_col {
                    cursor = (row_index, used);
                }
                current.push_str(&cell);
                used += w;
                count += 1;
            }
            if on_cursor_line && cursor_col == count {
                // 桁が満ちた行末のカーソルは次の行頭に置く。
                if used >= width {
                    rows.push(std::mem::take(&mut current));
                    row_index += 1;
                    used = 0;
                }
                cursor = (row_index, used);
            }
            rows.push(current);
        }
        (rows, cursor)
    }
}

/// 入力へ入れられる文字だけにする（改行は `\n` に統一、タブは空白、他の制御文字は捨てる）。
fn clean(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {}
            '\r' | '\n' => out.push('\n'),
            '\t' => out.push_str("    "),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// 1文字の表示形。入力中の双方向制御などは見える形にする。
fn display_char(c: char) -> String {
    let mut buf = [0; 4];
    sanitize::inline(c.encode_utf8(&mut buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_at_the_cursor_with_multibyte_characters() {
        let mut buf = TextBuf::default();
        buf.insert_str("あい");
        buf.left();
        buf.insert_char('x');
        assert_eq!(buf.as_str(), "あxい");
        buf.backspace();
        buf.delete();
        assert_eq!(buf.as_str(), "あ");
        buf.backspace();
        buf.backspace();
        assert!(buf.is_empty());
        buf.delete();
    }

    #[test]
    fn paste_normalizes_newlines_and_drops_terminal_controls() {
        let mut buf = TextBuf::default();
        buf.insert_str("a\r\nb\rc\u{1b}[31m\t\u{9b}");
        assert_eq!(buf.as_str(), "a\nb\nc[31m    ");
        assert!(!buf.as_str().chars().any(|c| c.is_control() && c != '\n'));
    }

    #[test]
    fn vertical_movement_keeps_the_goal_column() {
        let mut buf = TextBuf::from_text("abcdef\nab\nabcdef");
        buf.up();
        assert_eq!(buf.cursor_position(), (1, 2));
        buf.up();
        assert_eq!(buf.cursor_position(), (0, 6));
        buf.down();
        assert_eq!(buf.cursor_position(), (1, 2));
        buf.down();
        assert_eq!(buf.cursor_position(), (2, 6));
        buf.down();
        assert_eq!(buf.cursor_position(), (2, 6));
    }

    #[test]
    fn horizontal_movement_resets_the_goal_column() {
        let mut buf = TextBuf::from_text("abcdef\nab\nabcdef");
        buf.up();
        buf.left();
        buf.down();
        assert_eq!(buf.cursor_position(), (2, 1));
    }

    #[test]
    fn home_end_stay_on_the_logical_line() {
        let mut buf = TextBuf::from_text("ab\ncd");
        buf.home();
        assert_eq!(buf.cursor_position(), (1, 0));
        buf.up();
        buf.end();
        assert_eq!(buf.cursor_position(), (0, 2));
    }

    #[test]
    fn layout_wraps_by_display_width_and_places_the_cursor() {
        let buf = TextBuf::from_text("あいうえお\nx");
        let (rows, cursor) = buf.layout(4);
        assert_eq!(rows, ["あい", "うえ", "お", "x"]);
        assert_eq!(cursor, (3, 1));

        let mut buf = TextBuf::from_text("abcd");
        let (rows, cursor) = buf.layout(4);
        // 桁が満ちた位置のカーソルは次の行頭。
        assert_eq!(rows, ["abcd", ""]);
        assert_eq!(cursor, (1, 0));
        buf.left();
        let (_, cursor) = buf.layout(4);
        assert_eq!(cursor, (0, 3));
    }

    #[test]
    fn layout_never_returns_control_characters() {
        let buf = TextBuf::from_text("a\u{202e}b\u{200b}");
        let (rows, _) = buf.layout(20);
        assert!(rows.iter().all(|r| !r.chars().any(char::is_control)));
        assert!(rows[0].contains("\\u{202E}"));
    }

    #[test]
    fn empty_buffer_has_one_empty_row_and_cursor_at_origin() {
        let (rows, cursor) = TextBuf::default().layout(10);
        assert_eq!(rows, [""]);
        assert_eq!(cursor, (0, 0));
    }
}
