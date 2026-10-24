//! 入力欄の補完（`@` メンバー・`:` 絵文字・行頭の `/` コマンド）。GUI の `suggest/` と同じ規則で、
//! 状態と候補の計算だけを持つ（描画は view.rs、キー操作は app.rs）。

use disnans_shared::User;

/// 候補の最大数。
pub const MAX_ITEMS: usize = 6;
/// `:` の補完を始める最小の文字数（`:)` など顔文字を邪魔しない）。
const EMOJI_MIN: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Mention,
    Emoji,
    Slash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// 一覧の表示。
    pub label: String,
    /// 入力欄に入れる文字列。
    pub insert: String,
    /// メンションのときの利用者 ID（送るとき `<@id>` に直す）。
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggest {
    pub kind: Kind,
    /// カーソル直前の、置き換える部分（記号を含む）の文字数。
    pub token_chars: usize,
    pub items: Vec<Item>,
    pub cursor: usize,
}

/// TUI 自身のスラッシュコマンド（引数なし。名前だけを送ると実行し、本文としては送らない）。
pub const SLASH: &[(&str, &str)] = &[
    ("settings", "設定を開く"),
    ("search", "検索を開く"),
    ("quit", "終了する"),
];

/// GUI の `EMOJI_NAMES` と同じ表（先頭が代表の名前）。
const EMOJI: &[(&str, &[&str])] = &[
    ("👍", &["thumbsup", "+1", "like"]),
    ("❤️", &["heart", "love"]),
    ("😂", &["joy", "lol"]),
    ("🎉", &["tada", "party"]),
    ("👀", &["eyes"]),
    ("🙏", &["pray", "thanks"]),
    ("😊", &["blush", "smile"]),
    ("😆", &["laughing", "satisfied"]),
    ("🥹", &["holding_back_tears"]),
    ("😭", &["sob", "cry"]),
    ("😮", &["open_mouth", "wow"]),
    ("🤔", &["thinking"]),
    ("😇", &["innocent"]),
    ("😎", &["sunglasses", "cool"]),
    ("🥳", &["partying_face"]),
    ("😴", &["sleeping"]),
    ("😱", &["scream"]),
    ("🤯", &["exploding_head", "mind_blown"]),
    ("🔥", &["fire"]),
    ("✨", &["sparkles"]),
    ("💯", &["100"]),
    ("✅", &["white_check_mark", "check"]),
    ("❌", &["x", "cross"]),
    ("⭐", &["star"]),
    ("👏", &["clap"]),
    ("🙌", &["raised_hands"]),
    ("💪", &["muscle"]),
    ("👌", &["ok_hand", "ok"]),
    ("🤝", &["handshake"]),
    ("🫡", &["saluting_face", "salute"]),
    ("🍣", &["sushi"]),
    ("🍺", &["beer"]),
    ("☕", &["coffee"]),
    ("🍰", &["cake"]),
    ("🐱", &["cat"]),
    ("🌸", &["cherry_blossom", "sakura"]),
];

/// カーソル直前の `sigil` から始まる語（空白などで区切られる）。`(語の文字数, 記号の後ろの検索語)`。
fn token(before: &str, sigil: char, allowed: impl Fn(char) -> bool) -> Option<(usize, String)> {
    let mut chars = 0;
    let mut query: Vec<char> = Vec::new();
    for c in before.chars().rev() {
        chars += 1;
        if c == sigil {
            // 記号の直前は、行頭か空白でなければ補完しない（`a@b` やURLの途中）。
            let prev = before.chars().rev().nth(chars);
            if prev.is_some_and(|p| !p.is_whitespace()) {
                return None;
            }
            query.reverse();
            return Some((chars, query.into_iter().collect()));
        }
        if !allowed(c) {
            return None;
        }
        query.push(c);
    }
    None
}

/// 入力欄のカーソル前の文字列から、出すべき補完を決める。
pub fn detect(before: &str, users: &[User]) -> Option<Suggest> {
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = &before[line_start..];
    if let Some((chars, q)) = token(line, '@', |c| {
        !c.is_whitespace() && !matches!(c, '@' | '<' | '>')
    }) {
        let q = q.to_lowercase();
        let mut found: Vec<&User> = users
            .iter()
            .filter(|u| {
                q.is_empty()
                    || u.display_name.to_lowercase().contains(&q)
                    || u.login_name.to_lowercase().contains(&q)
            })
            .collect();
        found.sort_by_key(|u| !u.display_name.to_lowercase().starts_with(&q));
        let items: Vec<Item> = found
            .into_iter()
            .take(MAX_ITEMS)
            .map(|u| Item {
                label: format!("@{}  {}", u.display_name, u.login_name),
                insert: format!("@{} ", u.display_name),
                user_id: Some(u.id.clone()),
            })
            .collect();
        return build(Kind::Mention, chars, items);
    }
    if let Some((chars, q)) = token(line, ':', |c| {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-')
    }) && q.chars().count() >= EMOJI_MIN
    {
        let q = q.to_lowercase();
        let items: Vec<Item> = EMOJI
            .iter()
            .filter(|(_, names)| names.iter().any(|n| n.contains(&q)))
            .take(MAX_ITEMS)
            .map(|(e, names)| Item {
                label: format!("{e}  :{}:", names[0]),
                insert: (*e).to_owned(),
                user_id: None,
            })
            .collect();
        return build(Kind::Emoji, chars, items);
    }
    // 行頭（入力全体の先頭）の `/名前` だけ。
    if line_start == 0
        && let Some(name) = line.strip_prefix('/')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        let items: Vec<Item> = SLASH
            .iter()
            .filter(|(n, _)| n.starts_with(&name.to_lowercase()))
            .map(|(n, d)| Item {
                label: format!("/{n}  {d}"),
                insert: format!("/{n}"),
                user_id: None,
            })
            .collect();
        // 名前が出そろっているなら、そのまま送れるので候補は出さない。
        if items.len() == 1 && items[0].insert == line {
            return None;
        }
        return build(Kind::Slash, line.chars().count(), items);
    }
    None
}

fn build(kind: Kind, token_chars: usize, items: Vec<Item>) -> Option<Suggest> {
    (!items.is_empty()).then_some(Suggest {
        kind,
        token_chars,
        items,
        cursor: 0,
    })
}

impl Suggest {
    pub fn step(&mut self, delta: isize) {
        let len = self.items.len();
        self.cursor = (self.cursor + len).wrapping_add_signed(delta) % len;
    }

    pub fn current(&self) -> &Item {
        &self.items[self.cursor]
    }
}

/// 送る前に、`@表示名` を `<@利用者ID>` に直す（長い名前から。ほかの名前の前半と取り違えないため）。
pub fn mentions_to_body(draft: &str, mentions: &[(String, String)]) -> String {
    let mut names: Vec<&(String, String)> =
        mentions.iter().filter(|(n, _)| !n.is_empty()).collect();
    names.sort_by_key(|(n, _)| std::cmp::Reverse(n.chars().count()));
    let mut out = String::new();
    let mut rest = draft;
    'scan: while let Some(c) = rest.chars().next() {
        if c == '@' {
            for (name, id) in &names {
                if let Some(after) = rest[1..].strip_prefix(name.as_str()) {
                    out.push_str(&format!("<@{id}>"));
                    rest = after;
                    continue 'scan;
                }
            }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, name: &str, login: &str) -> User {
        User {
            id: id.into(),
            login_name: login.into(),
            display_name: name.into(),
            avatar_url: None,
            created_at: 0,
        }
    }

    #[test]
    fn mention_matches_names_and_logins_and_needs_a_word_start() {
        let users = [user("u1", "Alice", "alice@gh"), user("u2", "Bob", "bob@gh")];
        let s = detect("hi @al", &users).unwrap();
        assert_eq!((s.kind, s.token_chars), (Kind::Mention, 3));
        assert_eq!(s.items[0].insert, "@Alice ");
        assert_eq!(detect("@", &users).unwrap().items.len(), 2);
        assert!(detect("mail@al", &users).is_none());
        assert!(detect("@zz", &users).is_none());
        assert_eq!(detect("x @bob@", &users), None);
    }

    #[test]
    fn emoji_needs_two_chars_and_slash_only_at_the_start() {
        let s = detect("ok :fir", &[]).unwrap();
        assert_eq!((s.kind, s.items[0].insert.as_str()), (Kind::Emoji, "🔥"));
        assert!(detect(":f", &[]).is_none());
        assert!(detect("12:30", &[]).is_none());
        let s = detect("/se", &[]).unwrap();
        assert_eq!((s.kind, s.items.len()), (Kind::Slash, 2));
        assert!(detect("a /se", &[]).is_none());
        assert!(detect("/zzz", &[]).is_none());
        assert!(detect("/quit", &[]).is_none());
        assert!(detect("l1\n/se", &[]).is_none());
    }

    #[test]
    fn mentions_become_ids_longest_name_first() {
        let m = vec![
            ("Al".to_owned(), "u1".to_owned()),
            ("Alice".to_owned(), "u2".to_owned()),
        ];
        assert_eq!(
            mentions_to_body("@Alice と @Al と @Zed と a@Al", &m),
            "<@u2> と <@u1> と @Zed と a<@u1>"
        );
    }
}
