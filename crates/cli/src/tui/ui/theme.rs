//! 色のトークン。画面のコードは `Color::Rgb(..)` を直接書かず、ここから引く。
//! 名前は GUI の CSS 変数（design-system の tokens.css）に対応する（docs/DESIGN.md の「色トークンの対応」）。
//! 今は組み込みの既定だけ。`theme.css` の読み込みは次の段階。

use ratatui::style::Color;

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    /// `--accent`: リンク・メンション・Chat タブ・枠のフォーカス
    pub accent: Color,
    /// `--accent` を背景に使うとき（自分のリアクション）
    pub accent_bg: Color,
    /// `--on-accent`: accent 背景の上の文字
    pub on_accent: Color,
    /// `--text-muted`: 区切り・補助・リストの記号
    pub text_muted: Color,
    /// `--surface`: 選択中のメッセージの背景
    pub surface: Color,
    /// `--surface-2`: 他の人のリアクションの背景
    pub surface_2: Color,
    /// `--mark`: 検索ヒット・ハイライトの背景
    pub mark: Color,
    /// インラインコードの文字（GUI は専用の変数なし）
    pub code: Color,
    /// `--danger`
    pub danger: Color,
    /// `--warning`
    pub warning: Color,
    /// 情報（通知・返信先。GUI に対応する変数なし）
    pub info: Color,
    /// アバターが無いときの投稿者の色
    pub palette: [Color; 6],
}

pub const DEFAULT: Theme = Theme {
    accent: Color::Rgb(90, 150, 255),
    accent_bg: Color::Rgb(30, 80, 150),
    on_accent: Color::White,
    text_muted: Color::DarkGray,
    surface: Color::Rgb(45, 45, 75),
    surface_2: Color::Rgb(60, 60, 70),
    mark: Color::Rgb(90, 80, 20),
    code: Color::Rgb(230, 190, 120),
    danger: Color::Red,
    warning: Color::Yellow,
    info: Color::Cyan,
    palette: [
        Color::Cyan,
        Color::Green,
        Color::Magenta,
        Color::Yellow,
        Color::LightBlue,
        Color::LightRed,
    ],
};

/// 色の深さ。`TrueColor` 以外では RGB を 256 色の番号へ寄せる（tmux などで RGB が通らないとき）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    TrueColor,
    Indexed,
}

static DEPTH: std::sync::OnceLock<Depth> = std::sync::OnceLock::new();
static CURRENT: std::sync::OnceLock<Theme> = std::sync::OnceLock::new();

/// 起動時に 1 回だけ、色の深さを決める（以後は変えない）。
pub fn init(depth: Depth) {
    let _ = DEPTH.set(depth);
}

fn depth() -> Depth {
    DEPTH.get().copied().unwrap_or(Depth::TrueColor)
}

/// RGB の色。深さが足りなければ 256 色の番号（6x6x6 の立方体）へ寄せる。
pub fn rgb(r: u8, g: u8, b: u8) -> Color {
    match depth() {
        Depth::TrueColor => Color::Rgb(r, g, b),
        Depth::Indexed => indexed(r, g, b),
    }
}

fn indexed(r: u8, g: u8, b: u8) -> Color {
    let level = |v: u8| (u16::from(v) * 5 + 127) / 255;
    Color::Indexed((16 + 36 * level(r) + 6 * level(g) + level(b)) as u8)
}

fn quantized(theme: &Theme) -> Theme {
    let q = |c: Color| match c {
        Color::Rgb(r, g, b) => indexed(r, g, b),
        other => other,
    };
    Theme {
        accent: q(theme.accent),
        accent_bg: q(theme.accent_bg),
        on_accent: q(theme.on_accent),
        text_muted: q(theme.text_muted),
        surface: q(theme.surface),
        surface_2: q(theme.surface_2),
        mark: q(theme.mark),
        code: q(theme.code),
        danger: q(theme.danger),
        warning: q(theme.warning),
        info: q(theme.info),
        palette: theme.palette.map(q),
    }
}

/// いま使うテーマ。
pub fn current() -> &'static Theme {
    match depth() {
        Depth::TrueColor => &DEFAULT,
        Depth::Indexed => CURRENT.get_or_init(|| quantized(&DEFAULT)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantizing_maps_rgb_into_the_256_color_cube_and_keeps_named_colors() {
        assert_eq!(indexed(0, 0, 0), Color::Indexed(16));
        assert_eq!(indexed(255, 255, 255), Color::Indexed(231));
        assert_eq!(indexed(255, 0, 0), Color::Indexed(196));
        let q = quantized(&DEFAULT);
        assert!(matches!(q.accent, Color::Indexed(_)));
        assert_eq!(q.danger, Color::Red);
    }
}
