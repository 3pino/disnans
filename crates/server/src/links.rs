//! 本文のリンク（`attachments/` のパスと、添付の ID の相互変換）。設計は `docs/PLAN_FILES.md` の 3b 節。
//!
//! サーバーが見るのは「パスの位置」だけ: `](パス)` の `)` まで、と `[[パス|` / `[[パス]]`。
//! 位置の前後の文字は変えない（`[[`、`![[`、`|別名` などの書き方はそのまま残す）。

use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// 保存する表記（添付の ID）の接頭辞。
pub const ID_PREFIX: &str = "disnans:file/";
/// 表示する表記（今の名前）の接頭辞。
const PATH_PREFIX: &str = "attachments/";

/// パスの位置を順に見て、`f` の戻り値で置き換える。`f` が `Err` を返したら止める。
fn rewrite_paths<E>(body: &str, mut f: impl FnMut(&str) -> Result<String, E>) -> Result<String, E> {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    loop {
        // 次の開き（`](` か `[[`）を探す
        let paren = rest.find("](").map(|p| (p, 2usize, ')'));
        let double = rest.find("[[").map(|p| (p, 2usize, '|'));
        let next = match (paren, double) {
            (Some(a), Some(b)) => Some(if a.0 <= b.0 { (a, true) } else { (b, false) }),
            (Some(a), None) => Some((a, true)),
            (None, Some(b)) => Some((b, false)),
            (None, None) => None,
        };
        let Some(((at, open_len, close), is_paren)) = next else {
            out.push_str(rest);
            return Ok(out);
        };
        let start = at + open_len;
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        // パスの終わり: `](` は `)`、`[[` は `|` か `]]` のどちらか早いほう
        let end = if is_paren {
            paren_end(after)
        } else {
            match (after.find(close), after.find("]]")) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            }
        };
        let Some(end) = end else {
            out.push_str(after);
            return Ok(out);
        };
        let path = &after[..end];
        out.push_str(&f(path)?);
        rest = &after[end..];
    }
}

/// `](` の後のパスの終わり。括弧は対になっていれば中に入れてよい（`photo (2).png`）。対にならない `)` で終わる。
fn paren_end(after: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in after.char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => return Some(i),
            ')' => depth -= 1,
            _ => {}
        }
    }
    None
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

/// 名前が、リンクの中に書けるか。区切りや `|` `]` 、改行は書けない。括弧は対になっているものだけ書ける。
fn linkable(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', '|', ']', '\n', '\r'])
        && paren_end(&format!("{name})")) == Some(name.len())
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
            vec!["photo (2).png"]
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
        assert!(!linkable("a|b"));
        assert!(!linkable("a]b"));
        assert!(!linkable(""));
    }
}
