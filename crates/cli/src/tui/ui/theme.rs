//! 色のトークン。画面のコードは `Color::Rgb(..)` を直接書かず、ここから引く。
//! 名前は GUI の CSS 変数（design-system の tokens.css）に対応する（docs/PLAN_TUI_UI.md の表）。
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

/// いま使うテーマ。
pub fn current() -> &'static Theme {
    &DEFAULT
}
