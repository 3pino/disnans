//! TUI の検索の状態（`/api/messages/search`）。画面の操作は `app.rs`、描画は `view.rs`。
//!
//! 流れ: 語を入力（Editing）→ Enter で検索（Loading）→ 結果から選ぶ（Browsing）。
//! Esc は 1 段戻る（結果 → 入力 → 閉じる）。結果の応答は番号（`seq`）で照合し、古い応答は捨てる。

use disnans_shared::Message;

use super::textbuf::TextBuf;

/// 1 回に取る件数。これだけ返ってきたら、さらに古い結果があるとみなす。
pub const LIMIT: u32 = 50;
/// 検索語の上限（サーバーは 200 文字を超えると 400）。
pub const QUERY_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// 語を入力している。
    Editing,
    /// 結果を待っている。
    Loading,
    /// 結果から選んでいる。
    Browsing,
    /// 選んだ結果の本文を読み取り専用で見ている（履歴には混ぜない）。
    Detail,
}

#[derive(Debug)]
pub struct Search {
    pub query: TextBuf,
    pub phase: Phase,
    /// 新しい順の結果。
    pub results: Vec<Message>,
    pub cursor: usize,
    /// さらに古い結果がありそう。
    pub more: bool,
    /// 続きを読んでいる最中。
    pub loading_more: bool,
    /// 直近に検索した語（続きの取得に使う。入力欄を編集しても変わらない）。
    pub last_query: String,
    pub error: Option<String>,
    /// いまの要求の番号。
    pub seq: u64,
    /// 詳細表示の先頭行。
    pub detail_scroll: usize,
}

impl Default for Search {
    fn default() -> Self {
        Self {
            query: TextBuf::default(),
            phase: Phase::Editing,
            results: Vec::new(),
            cursor: 0,
            more: false,
            loading_more: false,
            last_query: String::new(),
            error: None,
            seq: 0,
            detail_scroll: 0,
        }
    }
}

impl Search {
    /// 入力から検索語を取り出す。空・長すぎは理由を返す。
    pub fn checked_query(&self) -> Result<String, String> {
        let text = self.query.as_str().trim().to_owned();
        if text.is_empty() {
            Err("検索する語を入力してください".to_owned())
        } else if text.chars().count() > QUERY_MAX {
            Err(format!("検索語は {QUERY_MAX} 文字までです"))
        } else {
            Ok(text)
        }
    }

    /// 結果を受け取る。`append` なら続き（ID の重複は除く）。
    pub fn accept(&mut self, found: Vec<Message>, append: bool) {
        self.more = found.len() >= LIMIT as usize;
        if append {
            for message in found {
                if !self.results.iter().any(|m| m.id == message.id) {
                    self.results.push(message);
                }
            }
        } else {
            self.results = found;
            self.cursor = 0;
        }
        self.loading_more = false;
        self.error = None;
        self.phase = Phase::Browsing;
    }
}
