//! 本文のリンク（`attachments/` のパスと、添付の ID の相互変換）。設計は `docs/PLAN_FILES.md` の 3b 節。
//!
//! サーバーが見るのは「パスの位置」だけ: `[文字](パス)` のパス、と `[[パス|` / `[[パス]]` のパス。
//! 読み方はクライアント core（`view::markdown`）と同じ。
//! 位置の前後の文字は変えない（`[[`、`![[`、`|別名` などの書き方はそのまま残す）。

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// 保存する表記（添付の ID）の接頭辞。
pub const ID_PREFIX: &str = "disnans:file/";
/// 表示する表記（今の名前）の接頭辞。
const PATH_PREFIX: &str = "attachments/";

/// パスの位置を順に見て、`f` の戻り値で置き換える。`f` が `Err` を返したら止める。
///
/// 読み方は `view::markdown`（クライアント core）と同じ:
/// - `[文字](パス)`: 文字は空でなく `[` を含まない。`(` の後は、括弧の入れ子を数えて、対にならない `)` まで。
/// - `[[パス]]` / `[[パス|別名]]`: パスは `|` か `]]` まで。`[` `]` を含まない。
///
/// 読めない `[` は文字のまま（次の `[` から読み直す）。`!` の有無は関係ない（埋め込みも同じ位置）。
fn rewrite_paths<E>(body: &str, mut f: impl FnMut(&str) -> Result<String, E>) -> Result<String, E> {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    // まだ out に写していない位置
    let mut copied = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let read = if bytes.get(i + 1) == Some(&b'[') {
            wiki_span(body, i)
        } else {
            link_span(body, i)
        };
        match read {
            Some((path_start, path_end, next)) => {
                out.push_str(&body[copied..path_start]);
                out.push_str(&f(&body[path_start..path_end])?);
                copied = path_end;
                i = next;
            }
            None => i += 1,
        }
    }
    out.push_str(&body[copied..]);
    Ok(out)
}

/// `[文字](パス)` を読む（i は `[`）。返すのは (パスの始まり, パスの終わり, 読み終わりの次の位置)。
fn link_span(body: &str, i: usize) -> Option<(usize, usize, usize)> {
    let close = i + 1 + body[i + 1..].find(']')?;
    let text = &body[i + 1..close];
    if text.trim().is_empty() || text.contains('[') || body.as_bytes().get(close + 1) != Some(&b'(')
    {
        return None;
    }
    let start = close + 2;
    let mut depth = 0usize;
    for (k, c) in body[start..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => return Some((start, start + k, start + k + 1)),
            ')' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// `[[パス]]` / `[[パス|別名]]` を読む（i は 1 つ目の `[`）。返すのは (パスの始まり, パスの終わり, 読み終わりの次の位置)。
fn wiki_span(body: &str, i: usize) -> Option<(usize, usize, usize)> {
    let start = i + 2;
    let close = start + body[start..].find("]]")?;
    let inner = &body[start..close];
    let (path, alias) = match inner.find('|') {
        Some(p) => (&inner[..p], Some(&inner[p + 1..])),
        None => (inner, None),
    };
    if path.is_empty() || path.contains(['[', ']']) {
        return None;
    }
    if let Some(a) = alias
        && (a.trim().is_empty() || a.contains(['[', ']']) || a.chars().any(char::is_control))
    {
        return None;
    }
    Some((start, start + path.len(), close + 2))
}

/// 本文の中の `attachments/` のパス（送信・編集の検査に使う）。
fn attachment_paths(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let _ = rewrite_paths::<()>(body, |p| {
        if let Some(name) = p.strip_prefix(PATH_PREFIX) {
            found.push(name.to_owned());
        }
        Ok(p.to_owned())
    });
    found
}

/// 本文の中の保存の表記（添付の ID）。
fn stored_ids(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let _ = rewrite_paths::<()>(body, |p| {
        if let Some(id) = p.strip_prefix(ID_PREFIX) {
            found.push(id.to_owned());
        }
        Ok(p.to_owned())
    });
    found
}

/// 名前が、リンクの中に書けるか。区切り・制御文字・`[` `]` `|` は書けない。括弧は対になっていること
/// （対にならないと、`[文字](…)` の終わりの読み方が変わる）。
fn linkable(name: &str) -> bool {
    if name.is_empty()
        || name.contains(['/', '\\', '[', ']', '|'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let mut depth = 0usize;
    for c in name.chars() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => return false,
            ')' => depth -= 1,
            _ => {}
        }
    }
    depth == 0
}

/// 送信・編集の本文: `attachments/<名前>` を、その添付の ID（`disnans:file/<ID>`）に置き換える。
/// 見つからない・削除済み・書けない名前のときは `invalid_link`。投稿されていない直接の添付（`library`）は見つかる。
pub async fn to_stored(pool: &SqlitePool, body: &str) -> AppResult<String> {
    let names = attachment_paths(body);
    let mut ids: HashMap<String, String> = HashMap::new();
    for name in names {
        if ids.contains_key(&name) {
            continue;
        }
        let id = if linkable(&name) {
            sqlx::query_scalar::<_, String>(
                "SELECT id FROM files
                 WHERE alias_key = ? AND deleted_at IS NULL AND (message_id IS NOT NULL OR library = 1)",
            )
            .bind(crate::attachment_names::key(&name))
            .fetch_optional(pool)
            .await?
        } else {
            None
        };
        match id {
            Some(id) => {
                ids.insert(name, id);
            }
            None => {
                return Err(AppError::bad_request(
                    "invalid_link",
                    format!("リンク先の添付が見つかりません（attachments/{name}）"),
                ));
            }
        }
    }
    rewrite_paths(body, |p| -> AppResult<String> {
        Ok(match p.strip_prefix(PATH_PREFIX) {
            Some(name) => format!("{ID_PREFIX}{}", ids[name]),
            None => p.to_owned(),
        })
    })
}

/// 表示の本文: 保存の表記（`disnans:file/<ID>`）を、その添付の今の名前（`attachments/<名前>`）に戻す。
/// 削除された添付は、消される直前の名前に戻す。知らない ID はそのまま残す。
pub async fn to_wire(pool: &SqlitePool, bodies: &[&str]) -> sqlx::Result<HashMap<String, String>> {
    let mut ids: Vec<String> = bodies.iter().flat_map(|b| stored_ids(b)).collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let json = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into());
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, file_name FROM files WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(json)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// 表示の本文を作る（`to_wire` で集めた名前を使う）。
pub fn render(body: &str, names: &HashMap<String, String>) -> String {
    rewrite_paths::<()>(body, |p| {
        Ok(
            match p.strip_prefix(ID_PREFIX).and_then(|id| names.get(id)) {
                Some(name) => format!("{PATH_PREFIX}{name}"),
                None => p.to_owned(),
            },
        )
    })
    .unwrap_or_else(|_| body.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_the_path_positions() {
        let body = "a [x](attachments/p.png) b [[attachments/q.pdf|名前]] c ![[attachments/v.mp4]] d [[docs/a.md]] e [t](docs/x)";
        assert_eq!(attachment_paths(body), vec!["p.png", "q.pdf", "v.mp4"]);
    }

    #[test]
    fn double_bracket_paths_end_at_the_pipe_or_the_close() {
        assert_eq!(attachment_paths("[[attachments/a.txt]]"), vec!["a.txt"]);
        assert_eq!(
            attachment_paths("[x](attachments/photo (2).png)"),
            vec!["photo (2).png"],
            "括弧は対なら中に書ける"
        );
        assert!(
            attachment_paths("(attachments/a.png)").is_empty(),
            "[文字] が無ければリンクではない"
        );
        assert_eq!(attachment_paths("[[attachments/a.txt|x]]"), vec!["a.txt"]);
        assert!(
            attachment_paths("[[attachments/a.txt").is_empty(),
            "閉じていない"
        );
    }

    #[test]
    fn stored_form_is_the_id_and_the_wire_form_is_the_current_name() {
        let stored = "[名前](disnans:file/ID1) と ![[disnans:file/ID2]] と [[disnans:file/ID3|x]]";
        let mut names = HashMap::new();
        names.insert("ID1".to_owned(), "new name.pdf".to_owned());
        names.insert("ID2".to_owned(), "v.mp4".to_owned());
        assert_eq!(
            render(stored, &names),
            "[名前](attachments/new name.pdf) と ![[attachments/v.mp4]] と [[disnans:file/ID3|x]]",
            "知らない ID はそのまま"
        );
    }

    #[test]
    fn text_around_the_links_is_kept_exactly() {
        let body = "前 ![[attachments/a.png]] 後";
        let mut names = HashMap::new();
        names.insert("ID".to_owned(), "x".to_owned());
        assert_eq!(
            render("前 ![[disnans:file/ID]] 後", &names),
            "前 ![[attachments/x]] 後"
        );
        assert_eq!(
            rewrite_paths::<()>(body, |p| Ok(p.to_owned())).unwrap(),
            body
        );
    }

    #[test]
    fn names_with_link_symbols_are_not_linkable() {
        assert!(linkable("photo (2).png"), "対になった括弧は書ける");
        assert!(!linkable("a)b.png"), "対にならない ) は書けない");
        assert!(!linkable("a(b.png"));
        assert!(!linkable("a|b"));
        assert!(!linkable("a]b"));
        assert!(!linkable(""));
    }
}
