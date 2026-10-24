//! 入力欄の補完の TUI 側（候補を一覧の文字列に直し、カーソルを持つ）。
//! 規則（何を出すか・順・件数）は core の `view::suggest`（GUI と同じ規則。fixture で確かめる）。
//! 描画は view.rs、キー操作は app.rs。

use disnans_client_core::view::suggest::{self as core, Kind as CoreKind};
use disnans_shared::User;

pub use disnans_client_core::view::suggest::Kind;

/// TUI 自身のスラッシュコマンド（引数なし。名前だけを送ると実行し、本文としては送らない）。
pub const SLASH: &[(&str, &str)] = &[
    ("settings", "設定を開く"),
    ("search", "検索を開く"),
    ("quit", "終了する"),
];

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

/// 入力欄のカーソル前の文字列から、出すべき補完を決める（コマンドは TUI の `SLASH`）。
pub fn detect(before: &str, users: &[User]) -> Option<Suggest> {
    detect_in(before, users, SLASH)
}

/// `commands` は名前と説明の組。
pub fn detect_in(before: &str, users: &[User], commands: &[(&str, &str)]) -> Option<Suggest> {
    let s = core::detect(before, users, commands)?;
    // TUI だけの決まり: 名前を打ち終えて候補が 1 つだけなら出さない。Enter（改行の設定でも）で `app.rs` がそのまま実行する。
    // GUI は候補を出し、Enter で選んでから送る（core の規則と fixture は GUI のまま）
    if s.kind == CoreKind::Slash && s.items.len() == 1 && before == s.items[0].insert.trim_end() {
        return None;
    }
    let (kind, token_chars) = (s.kind, s.chars);
    let items = s
        .items
        .into_iter()
        .map(|c| {
            let label = match kind {
                CoreKind::Mention => format!("@{}  {}", c.title, c.detail),
                CoreKind::Emoji => format!("{}  {}", c.insert, c.title),
                CoreKind::Slash => format!("{}  {}", c.title, c.detail),
            };
            Item {
                label,
                insert: c.insert,
                user_id: (kind == CoreKind::Mention).then_some(c.key),
            }
        })
        .collect();
    Some(Suggest {
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
        assert_eq!(s.items[0].user_id.as_deref(), Some("u1"));
        assert_eq!(detect("@", &users).unwrap().items.len(), 2);
        assert!(detect("mail@al", &users).is_none());
        assert!(detect("@zz", &users).is_none());
        assert_eq!(detect("x @bob@", &users), None);
        // GUI と同じく、`(` と全角の `（` の後ろからも始まる
        assert_eq!(detect("(@bo", &users).unwrap().token_chars, 3);
        assert_eq!(detect("（@bo", &users).unwrap().token_chars, 3);
    }

    /// core と GUI が通す fixture（`client-core/tests/fixtures/suggest/*.json`）を、TUI の変換層にも通す。
    /// 見るのは種類・置き換える部分・挿入する文字列・利用者 ID・一覧の文字（見せる名前）。
    /// TUI だけの決まり（名前を打ち終えたコマンドは出さない）は、fixture の期待値より優先する。
    #[test]
    fn tui_matches_the_shared_suggest_fixtures() {
        use serde_json::Value;
        let files = [
            (
                "mention.json",
                include_str!("../../../client-core/tests/fixtures/suggest/mention.json"),
            ),
            (
                "emoji.json",
                include_str!("../../../client-core/tests/fixtures/suggest/emoji.json"),
            ),
            (
                "slash.json",
                include_str!("../../../client-core/tests/fixtures/suggest/slash.json"),
            ),
            (
                "order.json",
                include_str!("../../../client-core/tests/fixtures/suggest/order.json"),
            ),
        ];
        let mut failures = Vec::new();
        for (file, text) in files {
            let f: Value = serde_json::from_str(text).unwrap();
            let users: Vec<User> = f["members"].as_array().map_or(Vec::new(), |a| {
                a.iter()
                    .map(|m| User {
                        id: m["id"].as_str().unwrap().into(),
                        login_name: m["login_name"].as_str().unwrap().into(),
                        display_name: m["display_name"].as_str().unwrap().into(),
                        avatar_url: None,
                        created_at: 0,
                    })
                    .collect()
            });
            let commands: Vec<(String, String)> =
                f["commands"].as_array().map_or(Vec::new(), |a| {
                    a.iter()
                        .map(|c| {
                            (
                                c["name"].as_str().unwrap().into(),
                                c["description"].as_str().unwrap().into(),
                            )
                        })
                        .collect()
                });
            let commands: Vec<(&str, &str)> = commands
                .iter()
                .map(|(n, d)| (n.as_str(), d.as_str()))
                .collect();
            for case in f["cases"].as_array().unwrap() {
                let name = case["name"].as_str().unwrap();
                let before = case["before"].as_str().unwrap();
                let got = detect_in(before, &users, &commands);
                let want = &case["expected"];
                // 名前を打ち終えたコマンド（候補が 1 つで、挿入が入力と同じ）は、TUI では出さない
                let tui_only_none = want["kind"] == "slash"
                    && want["items"].as_array().is_some_and(|i| i.len() == 1)
                    && want["replaced"].as_str()
                        == want["items"][0]["insert"].as_str().map(str::trim_end);
                if tui_only_none {
                    if got.is_some() {
                        failures.push(format!(
                            "{file} {name}: TUI should show nothing for an exact name"
                        ));
                    }
                    continue;
                }
                match (&got, want.is_null()) {
                    (None, true) => continue,
                    (Some(s), false) => {
                        let kind = match s.kind {
                            Kind::Mention => "mention",
                            Kind::Emoji => "emoji",
                            Kind::Slash => "slash",
                        };
                        let n = before.chars().count();
                        let replaced: String = before.chars().skip(n - s.token_chars).collect();
                        let inserts: Vec<&str> =
                            s.items.iter().map(|i| i.insert.as_str()).collect();
                        let want_inserts: Vec<&str> = want["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|i| i["insert"].as_str().unwrap())
                            .collect();
                        let titles_ok = s.items.iter().zip(want["items"].as_array().unwrap()).all(
                            |(got, want)| {
                                let title = want["title"].as_str().unwrap();
                                match s.kind {
                                    Kind::Mention => got.label.starts_with(&format!("@{title}  ")),
                                    Kind::Emoji => {
                                        got.label
                                            == format!(
                                                "{}  {title}",
                                                want["insert"].as_str().unwrap()
                                            )
                                    }
                                    Kind::Slash => got.label.starts_with(&format!("{title}  ")),
                                }
                            },
                        );
                        let ids_ok = s.items.iter().zip(want["items"].as_array().unwrap()).all(
                            |(got, want)| match s.kind {
                                Kind::Mention => got.user_id.as_deref() == want["key"].as_str(),
                                _ => got.user_id.is_none(),
                            },
                        );
                        if kind != want["kind"]
                            || replaced != want["replaced"]
                            || inserts != want_inserts
                            || !titles_ok
                            || !ids_ok
                        {
                            failures.push(format!(
                                "{file} {name}: got {kind} {replaced:?} {inserts:?}, expected {}",
                                want
                            ));
                        }
                    }
                    (got, _) => {
                        failures.push(format!("{file} {name}: got {got:?}, expected {want}"))
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} case(s) differ:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn mention_query_is_at_most_32_chars() {
        let long = "a".repeat(33);
        let users = [user("u1", &long, "x")];
        assert!(detect(&format!("@{}", "a".repeat(32)), &users).is_some());
        assert!(detect(&format!("@{long}"), &users).is_none());
    }

    #[test]
    fn emoji_starts_at_one_char_and_slash_only_at_the_start() {
        let s = detect(":f", &[]).unwrap();
        assert_eq!((s.kind, s.items[0].insert.as_str()), (Kind::Emoji, "🔥"));
        assert!(detect("12:30", &[]).is_none());
        let s = detect("/se", &[]).unwrap();
        assert_eq!((s.kind, s.items.len()), (Kind::Slash, 2));
        assert!(detect("a /se", &[]).is_none());
        assert!(detect("/zzz", &[]).is_none());
        assert!(detect("l1\n/se", &[]).is_none());
    }

    #[test]
    fn emoji_label_shows_the_matched_alias_and_the_list_is_ranked() {
        // 打った文字に合う名前を見せる（GUI と同じ）
        let s = detect(":sak", &[]).unwrap();
        assert_eq!(s.items[0].label, "🌸  :sakura:");
        // 前方一致が先（`:e` は eyes・exploding_head が先頭）
        let s = detect(":e", &[]).unwrap();
        assert_eq!(s.items.len(), 8);
        assert_eq!(s.items[0].insert, "👀");
        assert_eq!(s.items[1].insert, "🤯");
    }

    #[test]
    fn slash_names_are_lowercase_and_insert_a_space() {
        assert!(detect("/Se", &[]).is_none());
        let s = detect_in("/me", &[], &[("memo", "メモ")]).unwrap();
        assert_eq!(s.items[0].insert, "/memo ");
        // 名前を打ち終えていれば出さない（TUI だけ。Enter でそのまま実行する）
        assert!(detect("/quit", &[]).is_none());
        assert!(detect("/qui", &[]).is_some());
    }

    #[test]
    fn a_mention_without_matches_falls_through_to_emoji() {
        let s = detect("@(:fi", &[]).unwrap();
        assert_eq!((s.kind, s.items[0].insert.as_str()), (Kind::Emoji, "🔥"));
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
