//! 入力欄の補完（`@` のメンバー・`:` の絵文字・行頭の `/` のコマンド名）の規則。純関数で、状態と描画は持たない。
//! 規則は GUI（`app/src/lib/suggest/`）と同じ。両方を `tests/fixtures/suggest/*.json` で確かめて揃える。
//! 結果の絞り込みは、キャレットより前の文字列だけで決まる。

use disnans_shared::User;

use super::emoji::EMOJI_NAMES;

/// 候補の最大数（GUI の既定と同じ）。
pub const LIST_LIMIT: usize = 8;
/// 記号のあとの検索語の最大の文字数（GUI の tokenBefore の既定と同じ）。
pub const QUERY_MAX: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Mention,
    Emoji,
    Slash,
}

/// 候補 1 件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// 候補の ID（メンションは利用者 ID、絵文字は絵文字、コマンドは名前）。
    pub key: String,
    /// 見せる名前（メンションは表示名、絵文字は `:名前:`、コマンドは `/名前`）。
    pub title: String,
    /// 選んだとき入力欄に入れる文字列。
    pub insert: String,
    /// 補足（メンションはログイン名、コマンドは説明）。
    pub detail: String,
}

/// いま出す補完。`chars` は、入力欄の末尾から置き換える文字数（記号を含む）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub kind: Kind,
    pub chars: usize,
    pub query: String,
    pub items: Vec<Candidate>,
}

/// キャレットより前の末尾にある `mark` から始まる語。`mark` の前は、行頭・空白・`(`・`（` のときだけ
/// （`mail@x` や `12:30` では出さないため）。戻り値は `(mark を含む文字数, 検索語)`。
pub fn token_before(
    before: &str,
    mark: char,
    allowed: impl Fn(char) -> bool,
    min: usize,
    max: usize,
) -> Option<(usize, String)> {
    let mut rev = before.chars().rev();
    let mut query = Vec::new();
    loop {
        let c = rev.next()?;
        if c == mark {
            break;
        }
        if !allowed(c) || query.len() >= max {
            return None;
        }
        query.push(c);
    }
    if query.len() < min {
        return None;
    }
    let boundary = rev
        .next()
        .is_none_or(|p| p.is_whitespace() || p == '(' || p == '（');
    if !boundary {
        return None;
    }
    query.reverse();
    Some((query.len() + 1, query.into_iter().collect()))
}

/// 前方一致を先に、部分一致をあとに並べる（同じ順位の中は元の順）。`LIST_LIMIT` まで。
fn rank<T>(items: Vec<T>, names: impl Fn(&T) -> Vec<String>, query: &str) -> Vec<T> {
    let q = query.to_lowercase();
    let score = |item: &T| {
        if q.is_empty() {
            return Some(0);
        }
        let ns: Vec<String> = names(item).iter().map(|n| n.to_lowercase()).collect();
        if ns.iter().any(|n| n.starts_with(&q)) {
            Some(0)
        } else if ns.iter().any(|n| n.contains(&q)) {
            Some(1)
        } else {
            None
        }
    };
    let mut scored: Vec<(u8, usize, T)> = items
        .into_iter()
        .enumerate()
        .filter_map(|(i, it)| score(&it).map(|s| (s, i, it)))
        .collect();
    scored.sort_by_key(|(s, i, _)| (*s, *i));
    scored
        .into_iter()
        .take(LIST_LIMIT)
        .map(|(_, _, it)| it)
        .collect()
}

fn emoji_candidates(query: &str) -> Vec<Candidate> {
    let q = query.to_lowercase();
    let table: Vec<(&str, &[&str])> = EMOJI_NAMES.to_vec();
    rank(
        table,
        |(_, names)| names.iter().map(|n| (*n).to_owned()).collect(),
        &q,
    )
    .into_iter()
    .map(|(emoji, names)| {
        // 打った文字に合う名前を見せる（前方一致 → 部分一致 → 代表の名前）
        let name = names
            .iter()
            .find(|n| n.starts_with(&q))
            .or_else(|| names.iter().find(|n| n.contains(&q)))
            .copied()
            .unwrap_or(names[0]);
        Candidate {
            key: emoji.to_owned(),
            title: format!(":{name}:"),
            insert: emoji.to_owned(),
            detail: String::new(),
        }
    })
    .collect()
}

fn member_candidates(users: &[User], query: &str) -> Vec<Candidate> {
    let q = query.to_lowercase();
    let mut found: Vec<&User> = users
        .iter()
        .filter(|u| {
            q.is_empty()
                || u.display_name.to_lowercase().contains(&q)
                || u.login_name.to_lowercase().contains(&q)
        })
        .collect();
    // 表示名が前方一致のものを先に（同じ中は元の順）
    found.sort_by_key(|u| !u.display_name.to_lowercase().starts_with(&q));
    found
        .into_iter()
        .take(LIST_LIMIT)
        .map(|u| Candidate {
            key: u.id.clone(),
            title: u.display_name.clone(),
            insert: format!("@{} ", u.display_name),
            detail: u.login_name.clone(),
        })
        .collect()
}

fn command_candidates(commands: &[(&str, &str)], query: &str) -> Vec<Candidate> {
    // 名前の順で並べてから絞る（GUI と同じ。名前は英小文字・数字・ハイフンだけなので、並びは辞書順と同じ）
    let mut sorted: Vec<(&str, &str)> = commands.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    rank(sorted, |(name, _)| vec![(*name).to_owned()], query)
        .into_iter()
        .map(|(name, description)| Candidate {
            key: name.to_owned(),
            title: format!("/{name}"),
            insert: format!("/{name} "),
            detail: description.to_owned(),
        })
        .collect()
}

/// 入力欄のキャレットより前の文字列から、出すべき補完を決める。
/// 出どころは、コマンド（行頭の `/`）→ メンバー（`@`）→ 絵文字（`:`）の順。候補が無い出どころは飛ばす。
/// `commands` は、名前と説明の組。
pub fn detect(before: &str, members: &[User], commands: &[(&str, &str)]) -> Option<Suggestion> {
    slash(before, commands)
        .or_else(|| mention(before, members))
        .or_else(|| emoji(before))
}

fn slash(before: &str, commands: &[(&str, &str)]) -> Option<Suggestion> {
    let query = before.strip_prefix('/')?;
    if !query
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    let items = command_candidates(commands, query);
    (!items.is_empty()).then(|| Suggestion {
        kind: Kind::Slash,
        chars: before.chars().count(),
        query: query.to_owned(),
        items,
    })
}

fn mention(before: &str, members: &[User]) -> Option<Suggestion> {
    let (chars, query) = token_before(
        before,
        '@',
        |c| !c.is_whitespace() && !matches!(c, '@' | '<' | '>'),
        0,
        QUERY_MAX,
    )?;
    let items = member_candidates(members, &query);
    (!items.is_empty()).then_some(Suggestion {
        kind: Kind::Mention,
        chars,
        query,
        items,
    })
}

fn emoji(before: &str) -> Option<Suggestion> {
    let (chars, query) = token_before(
        before,
        ':',
        |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-'),
        1,
        QUERY_MAX,
    )?;
    let items = emoji_candidates(&query);
    (!items.is_empty()).then_some(Suggestion {
        kind: Kind::Emoji,
        chars,
        query,
        items,
    })
}
