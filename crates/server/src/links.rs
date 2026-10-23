//! 本文のリンク（`attachments/` のパスと、添付の ID の相互変換）。設計は `docs/API.md` の「本文のリンク」。
//!
//! サーバーが見るのは「パスの位置」だけ: `[文字](パス)` のパス、と `[[パス|` / `[[パス]]` のパス。
//! 読み方はクライアント core（`view::markdown`）と同じ。コードのフェンスとインラインのコードの中は読まない。
//! 本文が真実: 添付は本文の `![[disnans:file/<ID>]]` で表し、`Message.attachments` は本文から導く。
//! 位置の前後の文字は変えない（`[[`、`![[`、`|別名` などの書き方はそのまま残す）。

use std::collections::HashMap;

use std::path::Path;

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
fn rewrite_paths<E>(body: &str, mut f: impl FnMut(&str, bool) -> Result<String, E>) -> Result<String, E> {
    let mut out = String::with_capacity(body.len());
    let mut in_fence = false;
    for line in body.split_inclusive('\n') {
        let text = line.trim_end_matches(['\n', '\r']);
        let inner = strip_quotes(text);
        if in_fence {
            if is_fence_close(inner) {
                in_fence = false;
            }
            out.push_str(line);
        } else if fence_lang(inner).is_some() {
            in_fence = true;
            out.push_str(line);
        } else {
            out.push_str(&rewrite_line(line, &mut f)?);
        }
    }
    Ok(out)
}

/// 1 行の中のパスの位置。`\x`（ASCII の記号）と、`…` のコードの中は読まない（core の inline と同じ）。
fn rewrite_line<E>(line: &str, f: &mut impl FnMut(&str, bool) -> Result<String, E>) -> Result<String, E> {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut copied = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if bytes.get(i + 1).is_some_and(|b| b.is_ascii_punctuation()) => i += 2,
            b'`' => match line[i + 1..].find('`') {
                // 空の `` はコードではない（core と同じ）
                Some(k) if k > 0 => i = i + 1 + k + 1,
                _ => i += 1,
            },
            b'[' => {
                let wiki = bytes.get(i + 1) == Some(&b'[');
                let read = if wiki {
                    wiki_span(line, i)
                } else {
                    link_span(line, i)
                };
                match read {
                    Some((path_start, path_end, next)) => {
                        out.push_str(&line[copied..path_start]);
                        out.push_str(&f(&line[path_start..path_end], wiki)?);
                        copied = path_end;
                        i = next;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&line[copied..]);
    Ok(out)
}

/// 行頭の `>`（引用）を外す（core の quote_inner と同じ: 行頭の空白は最大 3 つ、`>` の後ろの空白は 1 つ）。
fn strip_quotes(mut line: &str) -> &str {
    loop {
        let spaces = line.bytes().take_while(|b| *b == b' ').count();
        if spaces > 3 {
            return line;
        }
        match line[spaces..].strip_prefix('>') {
            Some(rest) => line = rest.strip_prefix(' ').unwrap_or(rest),
            None => return line,
        }
    }
}

/// core の fence_rest: 行頭の空白（最大 3 つ）の後ろの ```。
fn fence_rest(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    if spaces > 3 {
        return None;
    }
    line[spaces..].strip_prefix("```")
}

/// 開きのフェンス: ``` の後ろに言語（空白と ` を含まない）だけ。core の fence_lang と同じ。
fn fence_lang(line: &str) -> Option<&str> {
    let rest = fence_rest(line)?.trim_start();
    let end = rest
        .find(|c: char| c == '`' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[end..].trim().is_empty().then_some(&rest[..end])
}

/// 閉じのフェンス: ``` の後ろが空白だけ。
fn is_fence_close(line: &str) -> bool {
    fence_rest(line).is_some_and(|rest| rest.trim().is_empty())
}

/// 本文が参照している添付の ID（順番どおり、重複なし）。コードの中は数えない。
pub fn ids_in(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in stored_ids(body) {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// 添付の埋め込みを本文の末尾に足す（まだ本文に無い ID だけ、順番どおり）。空の本文には改行を入れない。
pub fn append_links(body: &str, ids: &[String]) -> String {
    let mut out = body.to_owned();
    let mut have = ids_in(&out);
    for id in ids {
        if have.contains(id) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("![[{ID_PREFIX}{id}]]"));
        have.push(id.clone());
    }
    out
}

/// 移行の計画: 本文を書き換えるメッセージ（ID と新しい本文）と、初回投稿の時刻を入れる添付の数。
pub struct BackfillPlan {
    pub bodies: Vec<(String, String)>,
    pub first_posted: i64,
}

impl BackfillPlan {
    pub fn is_empty(&self) -> bool {
        self.bodies.is_empty() && self.first_posted == 0
    }
}

/// 起動時の移行（冪等）。投稿されていた添付で本文に埋め込みの無いものを、位置の順に本文の末尾へ足す。
/// 初回投稿の時刻（`first_posted_at`）は、紐付いたメッセージの作成時刻。何もなければ空。
pub async fn plan_backfill(pool: &SqlitePool) -> sqlx::Result<BackfillPlan> {
    let first_posted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM files WHERE message_id IS NOT NULL AND first_posted_at IS NULL",
    )
    .fetch_one(pool)
    .await?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT m.id, m.body, f.id FROM files f JOIN messages m ON m.id = f.message_id
         ORDER BY m.created_at, m.id, f.position, f.id",
    )
    .fetch_all(pool)
    .await?;
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();
    for (message_id, body, file_id) in rows {
        match groups.iter_mut().find(|(id, _, _)| *id == message_id) {
            Some((_, _, files)) => files.push(file_id),
            None => groups.push((message_id, body, vec![file_id])),
        }
    }
    let mut bodies = Vec::new();
    for (message_id, body, files) in groups {
        let new_body = append_links(&body, &files);
        if new_body != body {
            bodies.push((message_id, new_body));
        }
    }
    Ok(BackfillPlan {
        bodies,
        first_posted,
    })
}

/// 移行の計画を書き込む（一つの transaction）。
pub async fn apply_backfill(pool: &SqlitePool, plan: &BackfillPlan) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    for (message_id, body) in &plan.bodies {
        sqlx::query("UPDATE messages SET body = ? WHERE id = ?")
            .bind(body)
            .bind(message_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE files SET first_posted_at = (SELECT m.created_at FROM messages m WHERE m.id = files.message_id)
         WHERE message_id IS NOT NULL AND first_posted_at IS NULL",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
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
/// 本文の中の `attachments/` のパス（テスト用）。
#[cfg(test)]
fn attachment_paths(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let _ = rewrite_paths::<()>(body, |p, _| {
        if let Some(name) = p.strip_prefix(PATH_PREFIX) {
            found.push(name.to_owned());
        }
        Ok(p.to_owned())
    });
    found
}

/// 本文の中のパス（`[文字](パス)` と `[[パス]]` の位置）と、`[[…]]` かどうか。
fn link_targets(body: &str) -> Vec<(String, bool)> {
    let mut found = Vec::new();
    let _ = rewrite_paths::<()>(body, |p, wiki| {
        found.push((p.to_owned(), wiki));
        Ok(p.to_owned())
    });
    found
}

pub(crate) fn stored_ids(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let _ = rewrite_paths::<()>(body, |p, _| {
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

/// 送信・編集の本文: 添付の名前のリンクを、その添付の ID（`disnans:file/<ID>`）に置き換える。
/// - `attachments/<名前>`（どの書き方でも）: 生きている添付（投稿済み・`library`）が無ければ `invalid_link`。
/// - `[[名前]]` / `![[名前]]`（パスに `/` を含まない）: `attachments/` にあればその添付。無ければ従来どおり（shared のパスの文字）。
///   同じ名前が shared の直下にもあれば `ambiguous_link`（`attachments/名前` と書けば解決）。
///
/// 本文の中の ID（クライアントが直接書いたもの）は、呼び出し側が `claim` で検査する。
pub async fn to_stored(pool: &SqlitePool, shared_dir: &Path, body: &str) -> AppResult<String> {
    let mut ids: HashMap<String, String> = HashMap::new();
    for (path, wiki) in link_targets(body) {
        if ids.contains_key(&path) {
            continue;
        }
        let (name, bare) = match path.strip_prefix(PATH_PREFIX) {
            Some(name) => (name.to_owned(), false),
            None if wiki && !path.contains('/') => (path.clone(), true),
            None => continue,
        };
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
        match (id, bare) {
            (Some(id), false) => {
                ids.insert(path, id);
            }
            (None, false) => {
                return Err(AppError::bad_request(
                    "invalid_link",
                    format!("リンク先の添付が見つかりません（attachments/{name}）"),
                ));
            }
            (Some(id), true) => {
                if shared_dir.join(&name).is_file() {
                    return Err(AppError::bad_request(
                        "ambiguous_link",
                        format!("同じ名前が添付と共有フォルダにあります（attachments/{name} と書いてください）"),
                    ));
                }
                ids.insert(path, id);
            }
            // 添付に無い `[[名前]]` は、従来どおりのただの文字（共有のパスとして残る）
            (None, true) => {}
        }
    }
    rewrite_paths(body, |p, _| -> AppResult<String> {
        Ok(match ids.get(p) {
            Some(id) => format!("{ID_PREFIX}{id}"),
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
    rewrite_paths::<()>(body, |p, _| {
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
            rewrite_paths::<()>(body, |p, _| Ok(p.to_owned())).unwrap(),
            body
        );
    }

    #[test]
    fn code_spans_fences_and_escapes_are_not_links() {
        assert!(attachment_paths("`[a](attachments/x.png)`").is_empty());
        assert!(attachment_paths("\\[a](attachments/x.png)").is_empty(), "\\ でエスケープ");
        assert_eq!(
            attachment_paths("```\n[a](attachments/x.png)\n```\n[a](attachments/y.png)"),
            vec!["y.png"],
            "フェンスの中は読まない、閉じたあとは読む"
        );
        assert!(
            attachment_paths("> ```rust\n> [a](attachments/x.png)\n> ```").is_empty(),
            "引用の中のフェンス"
        );
        assert_eq!(
            attachment_paths("````\n[a](attachments/x.png)"),
            vec!["x.png"],
            "4 つのバッククォートは、core と同じくフェンスではない（言語が ` で始まる）"
        );
        assert_eq!(
            attachment_paths("``` rust x\n[a](attachments/x.png)\n```"),
            vec!["x.png"],
            "言語の後ろに余分な語があるとフェンスではない"
        );
    }

    #[test]
    fn append_skips_ids_already_in_the_body_and_adds_no_newline_to_an_empty_body() {
        let ids = vec!["A".to_owned(), "B".to_owned()];
        assert_eq!(append_links("", &ids), "![[disnans:file/A]]\n![[disnans:file/B]]");
        assert_eq!(append_links("x ![[disnans:file/A]]", &ids), "x ![[disnans:file/A]]\n![[disnans:file/B]]");
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
