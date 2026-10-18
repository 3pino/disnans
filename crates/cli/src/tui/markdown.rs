//! Markdown の木（core の `view::markdown`）を、端末の装飾つきの文字（セル）の行にする。
//!
//! 描画（色・修飾）は `view.rs` が `Deco` から決める。ここは文字と装飾の種類だけを扱う。
//! サーバー由来の文字列はすべて `sanitize::escape_text` を通してから出す。

use disnans_client_core::view::markdown::{self, Block, Inline};

use super::sanitize;

/// 装飾の種類（ビットの組み合わせ）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Deco(pub u16);

impl Deco {
    pub const NONE: Deco = Deco(0);
    pub const BOLD: u16 = 1;
    pub const ITALIC: u16 = 2;
    pub const UNDERLINE: u16 = 4;
    pub const STRIKE: u16 = 8;
    pub const CODE: u16 = 16;
    pub const LINK: u16 = 32;
    pub const QUOTE: u16 = 64;
    pub const MENTION: u16 = 128;
    pub const HIGHLIGHT: u16 = 256;
    pub const REACTION: u16 = 512;
    pub const REACTION_MINE: u16 = 1024;
    /// リストの記号（薄く出す）。
    pub const MARKER: u16 = 2048;

    pub fn has(self, flag: u16) -> bool {
        self.0 & flag != 0
    }

    fn with(self, flag: u16) -> Deco {
        Deco(self.0 | flag)
    }
}

pub type Cell = (char, Deco);

/// 論理的な1行。折り返すときは、先頭の行に `first`、続きの行に `rest` を前置する。
#[derive(Debug, Clone, Default)]
pub struct MdLine {
    pub first: Vec<Cell>,
    pub rest: Vec<Cell>,
    pub content: Vec<Cell>,
}

fn cells(text: &str, deco: Deco) -> Vec<Cell> {
    text.chars().map(|c| (c, deco)).collect()
}

fn prepend(target: &mut Vec<Cell>, mut head: Vec<Cell>) {
    head.append(target);
    *target = head;
}

fn width_of(cells: &[Cell]) -> usize {
    cells.iter().map(|(c, _)| sanitize::char_width(*c)).sum()
}

/// 本文を行にする。`name_of` はメンションの表示名（分からなければ呼び出し側が代わりの文言を返す）。
pub fn render(body: &str, name_of: &dyn Fn(&str) -> String) -> Vec<MdLine> {
    blocks(&markdown::parse(body), name_of, false)
}

fn blocks(list: &[Block], name_of: &dyn Fn(&str) -> String, blank_between: bool) -> Vec<MdLine> {
    let mut out = Vec::new();
    for (i, block) in list.iter().enumerate() {
        if i > 0 && blank_between {
            out.push(MdLine::default());
        }
        match block {
            Block::Paragraph { lines } => {
                for line in lines {
                    out.push(MdLine {
                        content: inline_cells(line, Deco::NONE, name_of),
                        ..MdLine::default()
                    });
                }
            }
            Block::Code { text, .. } => {
                for line in text.split('\n') {
                    let bar = cells("│ ", Deco(Deco::CODE));
                    out.push(MdLine {
                        first: bar.clone(),
                        rest: bar,
                        content: cells(&sanitize::escape_text(line, false), Deco(Deco::CODE)),
                    });
                }
            }
            Block::Quote { children } => {
                for mut line in blocks(children, name_of, false) {
                    let bar = cells("▎ ", Deco(Deco::QUOTE));
                    prepend(&mut line.first, bar.clone());
                    prepend(&mut line.rest, bar);
                    out.push(line);
                }
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (n, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", start + n as u64)
                    } else {
                        "• ".to_owned()
                    };
                    let indent = " ".repeat(sanitize::display_width(&marker));
                    if item.lines.is_empty() {
                        out.push(MdLine {
                            first: cells(&marker, Deco(Deco::MARKER)),
                            rest: cells(&indent, Deco::NONE),
                            content: Vec::new(),
                        });
                    }
                    for (i, line) in item.lines.iter().enumerate() {
                        out.push(MdLine {
                            first: if i == 0 {
                                cells(&marker, Deco(Deco::MARKER))
                            } else {
                                cells(&indent, Deco::NONE)
                            },
                            rest: cells(&indent, Deco::NONE),
                            content: inline_cells(line, Deco::NONE, name_of),
                        });
                    }
                    for mut line in blocks(&item.children, name_of, false) {
                        prepend(&mut line.first, cells(&indent, Deco::NONE));
                        prepend(&mut line.rest, cells(&indent, Deco::NONE));
                        out.push(line);
                    }
                }
            }
        }
    }
    out
}

fn inline_cells(items: &[Inline], deco: Deco, name_of: &dyn Fn(&str) -> String) -> Vec<Cell> {
    let mut out = Vec::new();
    for item in items {
        match item {
            Inline::Text { text } => out.extend(cells(&sanitize::escape_text(text, false), deco)),
            Inline::Bold { children } => {
                out.extend(inline_cells(children, deco.with(Deco::BOLD), name_of));
            }
            Inline::Italic { children } => {
                out.extend(inline_cells(children, deco.with(Deco::ITALIC), name_of));
            }
            Inline::Underline { children } => {
                out.extend(inline_cells(children, deco.with(Deco::UNDERLINE), name_of));
            }
            Inline::Strike { children } => {
                out.extend(inline_cells(children, deco.with(Deco::STRIKE), name_of));
            }
            Inline::Highlight { children } => {
                out.extend(inline_cells(children, deco.with(Deco::HIGHLIGHT), name_of));
            }
            Inline::Code { text } => out.extend(cells(
                &sanitize::escape_text(text, false),
                deco.with(Deco::CODE),
            )),
            Inline::Link { href, text } => {
                let style = deco.with(Deco::LINK);
                out.extend(cells(&sanitize::escape_text(text, false), style));
                if text != href {
                    let shown = format!(" ({})", sanitize::escape_text(href, false));
                    out.extend(cells(&shown, style));
                }
            }
            Inline::Mention { user_id } => {
                let shown = format!("@{}", name_of(user_id));
                out.extend(cells(&shown, deco.with(Deco::MENTION)));
            }
        }
    }
    out
}

/// セルの行を表示幅 `width` 桁以内へ折り返す。できれば直前の空白で切る。空なら空行1つ。
pub fn wrap_cells(line: &[Cell], width: usize) -> Vec<Vec<Cell>> {
    let width = width.max(1);
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut current: Vec<Cell> = Vec::new();
    let mut used = 0;
    for &cell in line {
        let w = sanitize::char_width(cell.0);
        if used + w > width && !current.is_empty() {
            if cell.0 == ' ' {
                rows.push(trim_end(std::mem::take(&mut current)));
                used = 0;
                continue;
            }
            let split = current.iter().rposition(|(c, _)| *c == ' ').filter(|i| {
                *i + 1 < current.len() && current[..=*i].iter().any(|(c, _)| *c != ' ')
            });
            let rest = match split {
                Some(i) => current.split_off(i + 1),
                None => Vec::new(),
            };
            rows.push(trim_end(std::mem::take(&mut current)));
            current = rest;
            used = width_of(&current);
        }
        current.push(cell);
        used += w;
    }
    rows.push(current);
    rows
}

fn trim_end(mut cells: Vec<Cell>) -> Vec<Cell> {
    while cells.last().is_some_and(|(c, _)| *c == ' ') {
        cells.pop();
    }
    cells
}

/// 表示行 1 つ（文字列と、装飾の範囲。範囲は文字列内のバイト位置）。
pub type LaidLine = (String, Vec<(usize, usize, Deco)>);

/// 論理行を、幅 `inner` 桁の表示行（文字列と、装飾の範囲）へ。範囲は文字列内のバイト位置。
pub fn layout_line(line: &MdLine, inner: usize) -> Vec<LaidLine> {
    let lead = width_of(&line.first).max(width_of(&line.rest));
    let avail = inner.saturating_sub(lead).max(1);
    wrap_cells(&line.content, avail)
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            let mut all = if i == 0 {
                line.first.clone()
            } else {
                line.rest.clone()
            };
            all.extend(chunk);
            to_text(&all)
        })
        .collect()
}

pub fn cells_to_content(
    cells: &[Cell],
    kind: super::transcript::RowKind,
) -> super::transcript::Content {
    let (text, spans) = to_text(cells);
    (kind, text, spans)
}

fn to_text(cells: &[Cell]) -> (String, Vec<(usize, usize, Deco)>) {
    let mut text = String::new();
    let mut spans: Vec<(usize, usize, Deco)> = Vec::new();
    for &(c, deco) in cells {
        let start = text.len();
        text.push(c);
        if deco == Deco::NONE {
            continue;
        }
        match spans.last_mut() {
            Some(last) if last.1 == start && last.2 == deco => last.1 = text.len(),
            _ => spans.push((start, text.len(), deco)),
        }
    }
    (text, spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(id: &str) -> String {
        if id == "u1" {
            "Alice".into()
        } else {
            "不明なユーザー".into()
        }
    }

    fn texts(body: &str, width: usize) -> Vec<String> {
        render(body, &name)
            .iter()
            .flat_map(|l| layout_line(l, width))
            .map(|(t, _)| t)
            .collect()
    }

    #[test]
    fn blocks_have_no_blank_lines_between_them_like_the_gui() {
        assert_eq!(texts("a\nb\n\nc", 20), ["a", "b", "c"]);
    }

    #[test]
    fn inline_decorations_become_spans_and_mentions_become_names() {
        let lines = render("**太字** と `code` <@u1> <@zz>", &name);
        let (text, spans) = layout_line(&lines[0], 40).remove(0);
        assert_eq!(text, "太字 と code @Alice @不明なユーザー");
        let kinds: Vec<(&str, bool, bool, bool)> = spans
            .iter()
            .map(|(s, e, d)| {
                (
                    &text[*s..*e],
                    d.has(Deco::BOLD),
                    d.has(Deco::CODE),
                    d.has(Deco::MENTION),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("太字", true, false, false),
                ("code", false, true, false),
                ("@Alice", false, false, true),
                ("@不明なユーザー", false, false, true),
            ]
        );
    }

    #[test]
    fn quotes_lists_and_fences_get_leads_that_repeat_when_wrapped() {
        assert_eq!(texts("> abcdef ghij", 8), ["▎ abcdef", "▎ ghij"]);
        assert_eq!(texts("- a\n- b", 20), ["• a", "• b"]);
        assert_eq!(texts("1. x\n2. y", 20), ["1. x", "2. y"]);
        assert_eq!(texts("```\nlet a = 1;\n```", 20), ["│ let a = 1;"]);
        assert_eq!(texts("- abcdef ghij", 8), ["• abcdef", "  ghij"]);
    }

    #[test]
    fn links_show_the_address_unless_it_is_the_text() {
        let lines = render("[docs](https://example.test/a)", &name);
        let (text, spans) = layout_line(&lines[0], 60).remove(0);
        assert_eq!(text, "docs (https://example.test/a)");
        assert!(spans.iter().all(|(_, _, d)| d.has(Deco::LINK)));
    }

    #[test]
    fn controls_are_escaped_and_wrapping_respects_width() {
        let out = texts("a\u{1b}[2Jb", 40);
        assert!(!out[0].chars().any(char::is_control), "{out:?}");
        for line in texts("あいうえおかきくけこ", 10) {
            assert!(sanitize::display_width(&line) <= 10, "{line:?}");
        }
    }
}
