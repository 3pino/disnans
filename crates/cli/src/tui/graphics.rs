//! ターミナルの画像表示（Kitty graphics / iTerm2 inline images）。
//! 文字の描画（ratatui）とは別に、画面へ載せ終わった後で画像だけを重ねる。
//! 切り抜きは画像を切り出し直して送る（ターミナル側の状態を持たない）。

use std::collections::HashMap;
use std::io::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::picture::{Prepared, crop_png};
use super::ui::theme;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    None,
    Kitty,
    Iterm2,
}

/// 環境から決めた、画像の出し方と色の深さ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Environment {
    pub protocol: Protocol,
    /// tmux のパススルー（`\x1bPtmux;…\x1b\\`）で包んで出す。
    pub tmux: bool,
    pub depth: theme::Depth,
}

/// tmux へ問い合わせる（`tmux <args>` の出力）。tmux の設定は読むだけで、変えない。
fn tmux_query(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("tmux")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// 使える画像プロトコルと色の深さを環境から決める。
/// `DISNANS_TUI_IMAGES=off|kitty|iterm2` で上書きできる。
/// tmux の中では、外側のターミナルが分かり、`allow-passthrough` が有効なときだけ画像を出す。
pub fn detect() -> Environment {
    detect_from(|k| std::env::var(k).ok(), tmux_query)
}

fn truthy(value: Option<&str>) -> bool {
    matches!(value, Some("on" | "all"))
}

/// tmux の中の、外側のターミナルの画像プロトコル。tmux 自身の `TERM_PROGRAM=tmux` や `TERM=screen` は見ない。
fn outer_protocol(get: &impl Fn(&str) -> Option<String>) -> Protocol {
    let program = get("TERM_PROGRAM").unwrap_or_default();
    let lc = get("LC_TERMINAL").unwrap_or_default();
    if get("KITTY_WINDOW_ID").is_some() || program.eq_ignore_ascii_case("ghostty") {
        Protocol::Kitty
    } else if get("WEZTERM_EXECUTABLE").is_some()
        || get("WEZTERM_PANE").is_some()
        || get("ITERM_SESSION_ID").is_some()
        || program == "WezTerm"
        || program == "iTerm.app"
        || lc == "iTerm2"
    {
        Protocol::Iterm2
    } else {
        Protocol::None
    }
}

fn detect_from(
    get: impl Fn(&str) -> Option<String>,
    tmux: impl Fn(&[&str]) -> Option<String>,
) -> Environment {
    let in_tmux = get("TMUX").is_some_and(|v| !v.is_empty());
    let forced = get("DISNANS_TUI_IMAGES").map(|value| match value.to_ascii_lowercase().as_str() {
        "kitty" => Protocol::Kitty,
        "iterm2" | "iterm" => Protocol::Iterm2,
        _ => Protocol::None,
    });
    let term = get("TERM").unwrap_or_default();
    let program = get("TERM_PROGRAM").unwrap_or_default();
    let color = get("COLORTERM").unwrap_or_default();
    let truecolor_env = color == "truecolor" || color == "24bit" || term.contains("direct");
    if !in_tmux {
        let protocol = forced.unwrap_or_else(|| {
            if get("STY").is_some() {
                Protocol::None
            } else if program == "WezTerm" || program == "iTerm.app" {
                Protocol::Iterm2
            } else if get("KITTY_WINDOW_ID").is_some()
                || term == "xterm-kitty"
                || program.eq_ignore_ascii_case("ghostty")
            {
                Protocol::Kitty
            } else {
                Protocol::None
            }
        });
        // tmux の外では色は従来どおり（RGB で出す）。
        return Environment {
            protocol,
            tmux: false,
            depth: theme::Depth::TrueColor,
        };
    }
    // tmux: RGB が通るか（外側が RGB を持つと tmux が知っている、または環境で示されている）。
    let has_rgb = |s: &str| {
        s.split([',', ':', ';', ' '])
            .any(|w| w == "RGB" || w == "Tc")
    };
    // 今つながっているクライアントの機能を優先する（global の設定は他のターミナル名向けのこともある）。
    // 答えが無い（古い tmux）ときだけ、設定の文字列から推測する。
    let features = tmux(&["display-message", "-p", "#{client_termfeatures}"]).unwrap_or_default();
    let rgb = truecolor_env
        || if features.trim().is_empty() {
            ["terminal-overrides", "terminal-features"]
                .iter()
                .any(|o| has_rgb(&tmux(&["show-options", "-sv", o]).unwrap_or_default()))
        } else {
            has_rgb(&features)
        };
    let depth = if rgb {
        theme::Depth::TrueColor
    } else {
        theme::Depth::Indexed
    };
    // 入れ子の tmux（外側のターミナル名が tmux/screen）は、何重に包むか分からないので画像は出さない。
    let outer = tmux(&["display-message", "-p", "#{client_termname}"]).unwrap_or_default();
    let nested = outer.starts_with("tmux") || outer.starts_with("screen");
    let passthrough = truthy(
        tmux(&["show-options", "-Apv", "allow-passthrough"])
            .as_deref()
            .map(str::trim),
    );
    let wanted = forced.unwrap_or_else(|| outer_protocol(&get));
    let protocol = if wanted == Protocol::None || !passthrough || (nested && forced.is_none()) {
        Protocol::None
    } else {
        wanted
    };
    Environment {
        protocol,
        tmux: protocol != Protocol::None,
        depth,
    }
}

/// tmux のパススルーで包む。中の ESC は 2 つにする。
fn wrap_tmux(seq: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(seq.len() + 16);
    out.extend_from_slice(b"\x1bPtmux;");
    for &b in seq {
        out.push(b);
        if b == 0x1b {
            out.push(0x1b);
        }
    }
    out.extend_from_slice(b"\x1b\\");
    out
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
    /// 画像の命令を tmux のパススルーで包む。
    tmux: bool,
    last: Vec<Placement>,
}

impl Graphics {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            tmux: false,
            last: Vec::new(),
        }
    }

    pub fn with_tmux(mut self, tmux: bool) -> Self {
        self.tmux = tmux;
        self
    }

    /// 画像の命令 1 つを `out` に足す（tmux の中ならパススルーで包む）。
    fn emit(&self, out: &mut Vec<u8>, seq: &[u8]) {
        if self.tmux {
            out.extend_from_slice(&wrap_tmux(seq));
        } else {
            out.extend_from_slice(seq);
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
            Protocol::Kitty => self.emit(out, b"\x1b_Ga=d,d=a,q=2\x1b\\"),
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
            let mut seq = Vec::new();
            match self.protocol {
                Protocol::Kitty => kitty(&mut seq, png, p.cols, p.rows),
                Protocol::Iterm2 => iterm2(&mut seq, png, p.cols, p.rows),
                Protocol::None => {}
            }
            self.emit(out, &seq);
        }
        out.extend_from_slice(b"\x1b8");
        self.last = next.to_vec();
    }

    /// 終了時に画像を消す（Kitty はターミナル側に残るため）。
    pub fn cleanup(&self, out: &mut Vec<u8>) {
        if self.protocol == Protocol::Kitty {
            self.emit(out, b"\x1b_Ga=d,d=A,q=2\x1b\\");
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

    fn no_tmux(_: &[&str]) -> Option<String> {
        None
    }

    fn protocol_of(pairs: &'static [(&'static str, &'static str)]) -> Protocol {
        detect_from(env(pairs), no_tmux).protocol
    }

    #[test]
    fn detects_by_environment_and_honors_override() {
        assert_eq!(
            protocol_of(&[("TERM_PROGRAM", "WezTerm")]),
            Protocol::Iterm2
        );
        assert_eq!(protocol_of(&[("TERM", "xterm-kitty")]), Protocol::Kitty);
        assert_eq!(protocol_of(&[("TERM", "xterm-256color")]), Protocol::None);
        assert_eq!(
            protocol_of(&[("TERM_PROGRAM", "WezTerm"), ("STY", "x")]),
            Protocol::None
        );
        assert_eq!(
            protocol_of(&[("DISNANS_TUI_IMAGES", "kitty"), ("STY", "x")]),
            Protocol::Kitty
        );
        assert_eq!(
            protocol_of(&[("DISNANS_TUI_IMAGES", "off"), ("TERM_PROGRAM", "WezTerm")]),
            Protocol::None
        );
    }

    fn tmux_with(
        allow: &'static str,
        outer_term: &'static str,
        features: &'static str,
    ) -> impl Fn(&[&str]) -> Option<String> {
        move |args| {
            let last = args.last().copied().unwrap_or("");
            Some(
                match last {
                    "allow-passthrough" => allow,
                    "#{client_termname}" => outer_term,
                    "#{client_termfeatures}" => features,
                    _ => "",
                }
                .to_owned(),
            )
        }
    }

    #[test]
    fn tmux_needs_passthrough_and_a_known_outer_terminal_and_is_never_reconfigured() {
        let wez: &[(&str, &str)] = &[
            ("TMUX", "/tmp/t,1,0"),
            ("WEZTERM_PANE", "3"),
            ("TERM_PROGRAM", "tmux"),
        ];
        let run = |pairs: &'static [(&'static str, &'static str)], allow, term, feat| {
            detect_from(env(pairs), tmux_with(allow, term, feat))
        };
        let on = run(wez, "on", "xterm-256color", "RGB,hyperlinks");
        assert_eq!(
            (on.protocol, on.tmux, on.depth),
            (Protocol::Iterm2, true, theme::Depth::TrueColor)
        );
        // 許可されていない・tmux が答えない: 出さない(tmux の設定は変えない)
        assert_eq!(
            run(wez, "off", "xterm-256color", "").protocol,
            Protocol::None
        );
        assert_eq!(detect_from(env(wez), no_tmux).protocol, Protocol::None);
        // 外側が分からない・入れ子: 出さない。入れ子でも上書きすれば出す。
        let unknown: &[(&str, &str)] = &[("TMUX", "x"), ("TERM_PROGRAM", "tmux")];
        assert_eq!(
            run(unknown, "on", "xterm-256color", "").protocol,
            Protocol::None
        );
        assert_eq!(run(wez, "on", "tmux-256color", "").protocol, Protocol::None);
        let forced: &[(&str, &str)] = &[("TMUX", "x"), ("DISNANS_TUI_IMAGES", "kitty")];
        assert_eq!(run(forced, "on", "screen", "").protocol, Protocol::Kitty);
        // 色: RGB を持たなければ 256 色へ。COLORTERM があれば RGB
        assert_eq!(run(wez, "on", "xterm", "").depth, theme::Depth::Indexed);
        // 今のクライアントの機能があれば、global の設定に RGB があっても、そちらを優先する
        let global_rgb = |args: &[&str]| {
            let last = args.last().copied().unwrap_or("");
            Some(
                match last {
                    "#{client_termfeatures}" => "256,hyperlinks",
                    "terminal-overrides" => "*:RGB",
                    "allow-passthrough" => "on",
                    _ => "",
                }
                .to_owned(),
            )
        };
        assert_eq!(
            detect_from(env(wez), global_rgb).depth,
            theme::Depth::Indexed
        );
        let colorterm: &[(&str, &str)] = &[("TMUX", "x"), ("COLORTERM", "truecolor")];
        assert_eq!(
            run(colorterm, "off", "xterm", "").depth,
            theme::Depth::TrueColor
        );
    }

    #[test]
    fn tmux_passthrough_doubles_escapes_only_around_image_commands() {
        assert_eq!(
            wrap_tmux(b"\x1b_Gx\x1b\\"),
            b"\x1bPtmux;\x1b\x1b_Gx\x1b\x1b\\\x1b\\"
        );
        let img = image();
        let mut g = Graphics::new(Protocol::Iterm2).with_tmux(true);
        let next = vec![placement(1, 0, 4)];
        let mut out = Vec::new();
        assert!(g.begin(&next, false, &mut out));
        g.finish(&next, |_| Some(&img), &mut out);
        let text = String::from_utf8_lossy(&out).into_owned();
        // 位置合わせ(CSI)は包まず、画像の命令だけ包む
        assert!(
            text.contains("\x1b[6;4H\x1bPtmux;\x1b\x1b]1337;File=inline=1"),
            "{text}"
        );
        assert!(text.contains("\x07\x1b\\"));
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
