//! ターミナルの画像表示（Kitty graphics / iTerm2 inline images）。
//! 文字の描画（ratatui）とは別に、画面へ載せ終わった後で画像だけを重ねる。
//! 切り抜きは画像を切り出し直して送る（ターミナル側の状態を持たない）。

use std::collections::HashMap;
use std::io::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::picture::{Prepared, crop_png};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    None,
    Kitty,
    Iterm2,
}

/// 使える画像プロトコルを環境から決める。`DISNANS_TUI_IMAGES=off|kitty|iterm2` で上書きできる。
/// tmux の中などでは通らないので、上書きしない限り使わない。
pub fn detect() -> Protocol {
    detect_from(|k| std::env::var(k).ok())
}

fn detect_from(get: impl Fn(&str) -> Option<String>) -> Protocol {
    if let Some(value) = get("DISNANS_TUI_IMAGES") {
        return match value.to_ascii_lowercase().as_str() {
            "kitty" => Protocol::Kitty,
            "iterm2" | "iterm" => Protocol::Iterm2,
            _ => Protocol::None,
        };
    }
    if get("TMUX").is_some() || get("STY").is_some() {
        return Protocol::None;
    }
    let term = get("TERM").unwrap_or_default();
    let program = get("TERM_PROGRAM").unwrap_or_default();
    if program == "WezTerm" || program == "iTerm.app" {
        Protocol::Iterm2
    } else if get("KITTY_WINDOW_ID").is_some()
        || term == "xterm-kitty"
        || program.eq_ignore_ascii_case("ghostty")
    {
        Protocol::Kitty
    } else {
        Protocol::None
    }
}

/// 画面に出す画像の1か所。`src_*` は画像の縦を `src_total` 等分したうちの何行目から何行目まで。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub key: String,
    pub col: u16,
    pub row: u16,
    pub cols: u16,
    pub rows: u16,
    pub src_start: u16,
    pub src_end: u16,
    pub src_total: u16,
}

pub struct Graphics {
    pub protocol: Protocol,
    last: Vec<Placement>,
}

impl Graphics {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            last: Vec::new(),
        }
    }

    /// 文字の描画の前に呼ぶ。配置が変わるなら、古い画像を消す出力を `out` に書いて `true`。
    pub fn begin(&mut self, next: &[Placement], force: bool, out: &mut Vec<u8>) -> bool {
        if self.protocol == Protocol::None {
            return false;
        }
        if !force && self.last == next {
            return false;
        }
        match self.protocol {
            Protocol::Kitty => out.extend_from_slice(b"\x1b_Ga=d,d=a,q=2\x1b\\"),
            Protocol::Iterm2 => {
                // 画像はセルに載っているので、古い範囲を空白で上書きして消す。
                out.extend_from_slice(b"\x1b7");
                for p in &self.last {
                    for y in 0..p.rows {
                        let _ = write!(out, "\x1b[{};{}H", p.row + y + 1, p.col + 1);
                        out.extend(std::iter::repeat_n(b' ', usize::from(p.cols)));
                    }
                }
                out.extend_from_slice(b"\x1b8");
            }
            Protocol::None => {}
        }
        true
    }

    /// 文字の描画の後に呼ぶ（`begin` が `true` だったとき）。新しい画像を重ねる。
    pub fn finish<'a>(
        &mut self,
        next: &[Placement],
        lookup: impl Fn(&str) -> Option<&'a Prepared>,
        out: &mut Vec<u8>,
    ) {
        let mut crops: HashMap<(String, u16, u16), Vec<u8>> = HashMap::new();
        out.extend_from_slice(b"\x1b7");
        for p in next {
            let Some(image) = lookup(&p.key) else {
                continue;
            };
            let whole = p.src_start == 0 && p.src_end >= p.src_total;
            let cropped;
            let png: &[u8] = if whole {
                &image.png
            } else {
                let entry = crops
                    .entry((p.key.clone(), p.src_start, p.src_end))
                    .or_insert_with(|| {
                        crop_png(&image.rgba, p.src_start, p.src_end, p.src_total)
                            .unwrap_or_default()
                    });
                cropped = entry.clone();
                &cropped
            };
            if png.is_empty() {
                continue;
            }
            let _ = write!(out, "\x1b[{};{}H", p.row + 1, p.col + 1);
            match self.protocol {
                Protocol::Kitty => kitty(out, png, p.cols, p.rows),
                Protocol::Iterm2 => iterm2(out, png, p.cols, p.rows),
                Protocol::None => {}
            }
        }
        out.extend_from_slice(b"\x1b8");
        self.last = next.to_vec();
    }

    /// 終了時に画像を消す（Kitty はターミナル側に残るため）。
    pub fn cleanup(&self, out: &mut Vec<u8>) {
        if self.protocol == Protocol::Kitty {
            out.extend_from_slice(b"\x1b_Ga=d,d=A,q=2\x1b\\");
        }
    }
}

fn kitty(out: &mut Vec<u8>, png: &[u8], cols: u16, rows: u16) {
    let data = STANDARD.encode(png);
    let chunks: Vec<&[u8]> = data.as_bytes().chunks(4096).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        let more = u8::from(i + 1 < chunks.len());
        if i == 0 {
            let _ = write!(out, "\x1b_Ga=T,f=100,c={cols},r={rows},C=1,q=2,m={more};");
        } else {
            let _ = write!(out, "\x1b_Gm={more};");
        }
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\x1b\\");
    }
}

fn iterm2(out: &mut Vec<u8>, png: &[u8], cols: u16, rows: u16) {
    let _ = write!(
        out,
        "\x1b]1337;File=inline=1;size={};width={cols};height={rows};preserveAspectRatio=0:{}\x07",
        png.len(),
        STANDARD.encode(png)
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::picture::{Kind, prepare};

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| {
            pairs
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn detects_by_environment_and_honors_override() {
        assert_eq!(
            detect_from(env(&[("TERM_PROGRAM", "WezTerm")])),
            Protocol::Iterm2
        );
        assert_eq!(
            detect_from(env(&[("TERM", "xterm-kitty")])),
            Protocol::Kitty
        );
        assert_eq!(
            detect_from(env(&[("TERM", "xterm-256color")])),
            Protocol::None
        );
        assert_eq!(
            detect_from(env(&[("TERM_PROGRAM", "WezTerm"), ("TMUX", "x")])),
            Protocol::None
        );
        assert_eq!(
            detect_from(env(&[("DISNANS_TUI_IMAGES", "kitty"), ("TMUX", "x")])),
            Protocol::Kitty
        );
        assert_eq!(
            detect_from(env(&[
                ("DISNANS_TUI_IMAGES", "off"),
                ("TERM_PROGRAM", "WezTerm")
            ])),
            Protocol::None
        );
    }

    fn placement(rows: u16, start: u16, end: u16) -> Placement {
        Placement {
            key: "k".into(),
            col: 3,
            row: 5,
            cols: 4,
            rows,
            src_start: start,
            src_end: end,
            src_total: 4,
        }
    }

    fn image() -> Prepared {
        let mut src = Vec::new();
        image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]))
            .write_to(&mut std::io::Cursor::new(&mut src), image::ImageFormat::Png)
            .unwrap();
        prepare(&src, Kind::Thumb).unwrap()
    }

    #[test]
    fn unchanged_placements_are_not_redrawn_and_changes_erase_first() {
        let img = image();
        let mut g = Graphics::new(Protocol::Iterm2);
        let next = vec![placement(2, 0, 2)];
        let mut out = Vec::new();
        assert!(g.begin(&next, false, &mut out));
        g.finish(&next, |_| Some(&img), &mut out);
        let text = String::from_utf8_lossy(&out).into_owned();
        assert!(text.contains("]1337;File=inline=1") && text.contains("width=4;height=2"));
        let mut again = Vec::new();
        assert!(!g.begin(&next, false, &mut again) && again.is_empty());
        // 変わったら、古い範囲(行6〜7)を空白で消してから描く。
        let mut moved = Vec::new();
        assert!(g.begin(&[], false, &mut moved));
        let text = String::from_utf8_lossy(&moved).into_owned();
        assert!(text.contains("\x1b[6;4H    ") && text.contains("\x1b[7;4H    "));
    }

    #[test]
    fn kitty_deletes_all_placements_and_chunks_large_data() {
        let img = image();
        let mut g = Graphics::new(Protocol::Kitty);
        let next = vec![placement(1, 1, 2)];
        let mut out = Vec::new();
        assert!(g.begin(&next, false, &mut out));
        assert!(out.starts_with(b"\x1b_Ga=d,d=a"));
        g.finish(&next, |_| Some(&img), &mut out);
        let text = String::from_utf8_lossy(&out).into_owned();
        assert!(text.contains("a=T,f=100,c=4,r=1,C=1,q=2,m=0;"), "{text}");
        let mut big = Vec::new();
        kitty(&mut big, &vec![7u8; 10_000], 2, 1);
        let text = String::from_utf8_lossy(&big).into_owned();
        assert!(text.contains("m=1;") && text.contains("\x1b_Gm=0;"));
    }

    #[test]
    fn disabled_protocol_does_nothing() {
        let mut g = Graphics::new(Protocol::None);
        let mut out = Vec::new();
        assert!(!g.begin(&[placement(1, 0, 4)], true, &mut out) && out.is_empty());
    }
}
