//! Markdown サブセットの構文木（ステップ8・V3）。
//!
//! `app/src/lib/markdown.ts` と同じ規則・同じ木の形（JSON も同じ）。GUI と core が同じ fixture
//! （`crates/client-core/tests/fixtures/view/markdown.json`）を通すことで揃える。
//! 文字の幅・描画には依存しない。HTML の文字列は作らない（木だけを返す）。
//!
//! 既知の差（未検証）: JS の `\p{L}` と `char::is_alphanumeric` は、結合記号などで一致しないことがある。
//! また JS は UTF-16 の 1 文字単位で見るので、サロゲートペアの文字の隣の `_` の判定が違うことがある。

use serde::{Deserialize, Serialize};

/// 行の中の 1 つの部品（TS の Inline と同じ）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Inline {
    Text { text: String },
    Bold { children: Vec<Inline> },
    Italic { children: Vec<Inline> },
    Underline { children: Vec<Inline> },
    Strike { children: Vec<Inline> },
    Highlight { children: Vec<Inline> },
    Code { text: String },
    Link { href: String, text: String },
    Mention { user_id: String },
}

/// リストの 1 項目。1 行目以降の段落行は `lines` に、入れ子のブロックは `children` に入る
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub lines: Vec<Vec<Inline>>,
    pub children: Vec<Block>,
}

/// ブロック（TS の Block と同じ）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Block {
    Paragraph {
        lines: Vec<Vec<Inline>>,
    },
    Code {
        lang: String,
        text: String,
    },
    Quote {
        children: Vec<Block>,
    },
    List {
        ordered: bool,
        start: u64,
        items: Vec<ListItem>,
    },
}

// ---- 文字の判定（JS の \s・trim・\p{N} と同じ範囲） ----

/// JS の `\s`（と trim）が扱う空白
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// 単語の文字（`[\p{L}\p{N}_]` の近似）
fn is_word(c: char) -> bool {
    c == '_' || c.is_alphanumeric()
}

/// URL に使えない文字（`[^\s<>"'`]` の否定）
fn is_url_stop(c: char) -> bool {
    is_js_space(c) || matches!(c, '<' | '>' | '"' | '\'' | '`')
}

fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|t| t.chars().next())
}

fn char_before(s: &str, i: usize) -> Option<char> {
    s.get(..i).and_then(|t| t.chars().next_back())
}

// ---- ブロックの行の判定 ----

/// `^ {0,3}```\s*([^`\s]*)\s*$` のとき、言語（空なら空文字）
fn fence_lang(line: &str) -> Option<String> {
    let rest = fence_rest(line)?;
    let r = rest.trim_start_matches(is_js_space);
    let end = r
        .find(|c: char| c == '`' || is_js_space(c))
        .unwrap_or(r.len());
    if r[end..].chars().all(is_js_space) {
        Some(r[..end].to_owned())
    } else {
        None
    }
}

/// `^ {0,3}```\s*$` のとき（閉じのフェンス）
fn is_fence_close(line: &str) -> bool {
    fence_rest(line).is_some_and(|rest| rest.chars().all(is_js_space))
}

/// 行頭の空白（最大 3 つ）と ``` の後ろ（` ```` ` の後）を返す
fn fence_rest(line: &str) -> Option<&str> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    if spaces > 3 {
        return None;
    }
    line[spaces..].strip_prefix("```")
}

/// `^ {0,3}>( ?)(.*)$` のとき、引用の中身（`>` の後の 1 つの空白は除く）
fn quote_inner(line: &str) -> Option<String> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line[spaces..].strip_prefix('>')?;
    let inner = rest.strip_prefix(' ').unwrap_or(rest);
    // `.` は行末の文字（\n \r \u2028 \u2029）に一致しない
    if inner.chars().any(|c| matches!(c, '\u{2028}' | '\u{2029}')) {
        return None;
    }
    Some(inner.to_owned())
}

/// リストの行の分け方（`[1]` インデント・`[2]` 記号・`[3]` 記号の後の空白・`[4]` 中身）
struct ListMatch {
    indent: String,
    marker: String,
    gap: String,
    content: String,
}

/// `^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$`
fn list_match(line: &str) -> Option<ListMatch> {
    let indent_len = line
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    let indent = &line[..indent_len];
    let rest = &line[indent_len..];
    let marker_len = if rest.starts_with(['-', '*', '+']) {
        1
    } else {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=9).contains(&digits) {
            return None;
        }
        match rest.as_bytes().get(digits) {
            Some(b'.' | b')') => digits + 1,
            _ => return None,
        }
    };
    let marker = &rest[..marker_len];
    let after = &rest[marker_len..];
    let gap_len = after
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    if gap_len == 0 {
        return None;
    }
    let gap = &after[..gap_len];
    let content = &after[gap_len..];
    if content
        .chars()
        .any(|c| matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return None;
    }
    Some(ListMatch {
        indent: indent.to_owned(),
        marker: marker.to_owned(),
        gap: gap.to_owned(),
        content: content.to_owned(),
    })
}

/// タブは 4 桁として数える
fn cols_of(ws: &str) -> usize {
    ws.chars().map(|c| if c == '\t' { 4usize } else { 1 }).sum()
}

fn indent_of(line: &str) -> &str {
    let len = line
        .bytes()
        .take_while(|b| *b == b' ' || *b == b'\t')
        .count();
    &line[..len]
}

/// 行頭から最大 n 桁ぶんの空白を取り除く（タブを途中で切るときは空白にする）
fn strip_indent(line: &str, n: usize) -> String {
    let bytes = line.as_bytes();
    let mut col = 0;
    let mut k = 0;
    while k < bytes.len() && col < n {
        match bytes[k] {
            b' ' => col += 1,
            b'\t' => {
                if col + 4 > n {
                    return format!("{}{}", " ".repeat(col + 4 - n), &line[k + 1..]);
                }
                col += 4;
            }
            _ => break,
        }
        k += 1;
    }
    line[k..].to_owned()
}

fn is_ordered(marker: &str) -> bool {
    marker.bytes().any(|b| b.is_ascii_digit())
}

fn leading_number(marker: &str) -> u64 {
    marker
        .bytes()
        .take_while(u8::is_ascii_digit)
        .fold(0, |n, b| n * 10 + u64::from(b - b'0'))
}

// ---- ブロック ----

/// 本文（改行で区切った文字列）を構文木にする
pub fn parse(src: &str) -> Vec<Block> {
    let normalized = src.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = normalized.split('\n').map(str::to_owned).collect();
    parse_blocks(&lines)
}

fn parse_blocks(lines: &[String]) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if js_trim(line).is_empty() {
            i += 1;
            continue;
        }

        if let Some(lang) = fence_lang(line) {
            let mut body: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !is_fence_close(&lines[i]) {
                body.push(&lines[i]);
                i += 1;
            }
            i += 1; // 閉じ（なければ末尾まで）
            blocks.push(Block::Code {
                lang,
                text: body.join("\n"),
            });
            continue;
        }

        if quote_inner(line).is_some() {
            let mut inner: Vec<String> = Vec::new();
            while i < lines.len() {
                match quote_inner(&lines[i]) {
                    Some(text) => inner.push(text),
                    None => break,
                }
                i += 1;
            }
            blocks.push(Block::Quote {
                children: parse_blocks(&inner),
            });
            continue;
        }

        if let Some(first) = list_match(line) {
            let (block, next) = parse_list(lines, i, first);
            blocks.push(block);
            i = next;
            continue;
        }

        // 段落: 空行・他のブロックの開始まで。改行はそのまま残す
        let mut para: Vec<Vec<Inline>> = Vec::new();
        while i < lines.len() {
            let l = &lines[i];
            if js_trim(l).is_empty()
                || fence_lang(l).is_some()
                || quote_inner(l).is_some()
                || list_match(l).is_some()
            {
                break;
            }
            para.push(parse_inline(l, 0));
            i += 1;
        }
        blocks.push(Block::Paragraph { lines: para });
    }
    blocks
}

/// リストを読む。項目の下に続く、先頭より深くインデントされた行は、その項目の中身になる。
/// 同じインデントで同じ種類の記号が来たら次の項目。空行を挟んでもリストは続く。
fn parse_list(lines: &[String], start: usize, first: ListMatch) -> (Block, usize) {
    let base_indent = cols_of(&first.indent);
    let ordered = is_ordered(&first.marker);
    let start_num = if ordered {
        leading_number(&first.marker)
    } else {
        1
    };
    let mut items: Vec<ListItem> = Vec::new();
    let mut m = first;
    let mut i = start;
    loop {
        // 項目の中身の桁。これより深い行は、この項目の続き（入れ子）として扱う
        let content_indent = cols_of(&m.indent) + m.marker.len() + cols_of(&m.gap);
        let mut body: Vec<String> = Vec::new();
        let mut j = i + 1;
        while j < lines.len() {
            let l = &lines[j];
            if js_trim(l).is_empty() {
                body.push(String::new());
                j += 1;
                continue;
            }
            if cols_of(indent_of(l)) <= base_indent {
                break;
            }
            body.push(strip_indent(l, content_indent));
            j += 1;
        }
        // 末尾の空行は項目の外（次の項目との間）
        while body.last().is_some_and(String::is_empty) {
            body.pop();
            j -= 1;
        }

        let mut sub = parse_blocks(&body);
        let mut line_nodes: Vec<Vec<Inline>> = vec![parse_inline(&m.content, 0)];
        // 項目の直後に続く段落行（空行なし）は、項目の文の続きとして同じ項目の行にまとめる
        let joins_paragraph = !body.is_empty()
            && !body[0].is_empty()
            && matches!(sub.first(), Some(Block::Paragraph { .. }));
        if joins_paragraph && let Block::Paragraph { lines: para } = sub.remove(0) {
            line_nodes.extend(para);
        }
        items.push(ListItem {
            lines: line_nodes,
            children: sub,
        });

        let mut k = j;
        while k < lines.len() && js_trim(&lines[k]).is_empty() {
            k += 1;
        }
        let next = if k < lines.len() {
            list_match(&lines[k])
        } else {
            None
        };
        match next {
            Some(n) if cols_of(&n.indent) == base_indent && is_ordered(&n.marker) == ordered => {
                m = n;
                i = k;
            }
            _ => {
                return (
                    Block::List {
                        ordered,
                        start: start_num,
                        items,
                    },
                    j,
                );
            }
        }
    }
}

// ---- 行の中（インライン） ----

const URL_PREFIX_LEN: usize = 7; // "http://"

/// `https?://` で始まるか（大文字小文字は問わない）。長さ（バイト）を返す
fn scheme_len(s: &str) -> Option<usize> {
    let lower = s.get(..8).map(str::to_ascii_lowercase);
    if lower.as_deref().is_some_and(|p| p.starts_with("https://")) {
        return Some(8);
    }
    if s.get(..URL_PREFIX_LEN)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
    {
        return Some(URL_PREFIX_LEN);
    }
    None
}

/// `https?://[^\s<>"'`]+` を位置 i で読む。終わりの位置を返す（1 文字以上なければ None）
fn raw_url_end(s: &str, i: usize) -> Option<usize> {
    let scheme = scheme_len(&s[i..])?;
    let body_start = i + scheme;
    let body = &s[body_start..];
    let len: usize = body
        .chars()
        .take_while(|c| !is_url_stop(*c))
        .map(char::len_utf8)
        .sum();
    if len == 0 {
        None
    } else {
        Some(body_start + len)
    }
}

/// URL の末尾の句読点や、対応しない閉じ括弧は URL に含めない
fn trim_url(url: &str) -> &str {
    let mut u = url;
    loop {
        let Some(last) = u.chars().next_back() else {
            return u;
        };
        if matches!(
            last,
            '.' | ',' | ':' | ';' | '!' | '?' | '。' | '、' | '！' | '？' | '\'' | '"'
        ) {
            u = &u[..u.len() - last.len_utf8()];
            continue;
        }
        if last == ')' {
            let open = u.matches('(').count();
            let close = u.matches(')').count();
            if close > open {
                u = &u[..u.len() - 1];
                continue;
            }
        }
        return u;
    }
}

/// `<@id>` が位置 i にあるとき、id と、その次の位置。id は `[A-Za-z0-9_-]{1,64}`
fn mention_at(s: &str, i: usize) -> Option<(&str, usize)> {
    let bytes = s.as_bytes();
    if bytes.get(i) != Some(&b'<') || bytes.get(i + 1) != Some(&b'@') {
        return None;
    }
    let start = i + 2;
    let len = bytes[start.min(bytes.len())..]
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_' || **b == b'-')
        .count();
    if !(1..=64).contains(&len) || bytes.get(start + len) != Some(&b'>') {
        return None;
    }
    Some((&s[start..start + len], start + len + 1))
}

/// かたまり（強調の記号を解釈しない部分）
enum Atom {
    Text { len: usize, text: String },
    Node { len: usize, node: Inline },
}

impl Atom {
    fn len(&self) -> usize {
        match self {
            Self::Text { len, .. } | Self::Node { len, .. } => *len,
        }
    }
}

fn atom_at(s: &str, i: usize) -> Option<Atom> {
    let bytes = s.as_bytes();
    match bytes[i] {
        b'\\' => {
            let next = *bytes.get(i + 1)?;
            if next.is_ascii_punctuation() {
                Some(Atom::Text {
                    len: 2,
                    text: (next as char).to_string(),
                })
            } else {
                None
            }
        }
        b'`' => {
            let close = s[i + 1..].find('`')? + i + 1;
            if close > i + 1 {
                Some(Atom::Node {
                    len: close - i + 1,
                    node: Inline::Code {
                        text: s[i + 1..close].to_owned(),
                    },
                })
            } else {
                None
            }
        }
        b'[' => link_at(s, i),
        b'<' => {
            let (id, end) = mention_at(s, i)?;
            Some(Atom::Node {
                len: end - i,
                node: Inline::Mention {
                    user_id: id.to_owned(),
                },
            })
        }
        b'h' | b'H' => {
            if i > 0 && bytes[i - 1].is_ascii_alphanumeric() {
                return None;
            }
            let end = raw_url_end(s, i)?;
            let url = trim_url(&s[i..end]);
            // `//` の後に 1 文字以上残るときだけ、リンクにする
            let slashes = url.find("//")?;
            if url.len() > slashes + 2 {
                Some(Atom::Node {
                    len: url.len(),
                    node: Inline::Link {
                        href: url.to_owned(),
                        text: url.to_owned(),
                    },
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

/// `[文字](https://...)` を読む。href が http(s) でなければ None（素のテキストになる）
fn link_at(s: &str, i: usize) -> Option<Atom> {
    let bytes = s.as_bytes();
    let close = s[i + 1..].find(']')? + i + 1;
    if close == i + 1 || bytes.get(close + 1) != Some(&b'(') {
        return None;
    }
    let text = &s[i + 1..close];
    if js_trim(text).is_empty() || text.contains('[') {
        return None;
    }
    // 括弧の対応を見て、リンクの閉じ ) を探す（URL 内の (…) を許す）
    let mut depth = 0usize;
    let mut k = close + 2;
    let mut found = None;
    while k < bytes.len() {
        match bytes[k] {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    found = Some(k);
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
        k += 1;
    }
    let end = found?;
    let href = &s[close + 2..end];
    if !is_http_href(href) {
        return None;
    }
    Some(Atom::Node {
        len: end + 1 - i,
        node: Inline::Link {
            href: href.to_owned(),
            text: text.to_owned(),
        },
    })
}

/// `^https?://[^\s<>"'`]+$`（大文字小文字は問わない）
fn is_http_href(href: &str) -> bool {
    scheme_len(href).is_some_and(|scheme| {
        let body = &href[scheme..];
        !body.is_empty() && body.chars().all(|c| !is_url_stop(c))
    })
}

/// 閉じ記号として使えるか（直前が空白でない、単語の途中でない、など）
fn close_ok(s: &str, k: usize, delim: &str) -> bool {
    let before = char_before(s, k);
    if before.is_none_or(is_js_space) {
        return false;
    }
    let after_pos = k + delim.len();
    // `_` と `__` は単語の途中（snake_case など）では閉じない
    if (delim == "_" || delim == "__") && char_at(s, after_pos).is_some_and(is_word) {
        return false;
    }
    // `*` の閉じが `**` の一部なら飛ばす
    if delim == "*" && (s.as_bytes().get(k + 1) == Some(&b'*') || s.as_bytes()[k - 1] == b'*') {
        return false;
    }
    true
}

/// 強調の閉じを探す。見つからなければ None
fn find_close(s: &str, from: usize, delim: &str) -> Option<usize> {
    let mut k = from;
    while k < s.len() {
        if let Some(atom) = atom_at(s, k) {
            k += atom.len();
            continue;
        }
        if k > from && s[k..].starts_with(delim) && close_ok(s, k, delim) {
            return Some(k);
        }
        k += char_at(s, k).map_or(1, char::len_utf8);
    }
    None
}

/// 2 文字の記号で囲む強調の種類
#[derive(Clone, Copy)]
enum Wrap {
    Bold,
    Strike,
    Underline,
    Highlight,
}

fn wrap(kind: Wrap, children: Vec<Inline>) -> Inline {
    match kind {
        Wrap::Bold => Inline::Bold { children },
        Wrap::Strike => Inline::Strike { children },
        Wrap::Underline => Inline::Underline { children },
        Wrap::Highlight => Inline::Highlight { children },
    }
}

/// 2 文字の記号で囲む強調。順に試す（`__` は `_` より先）
const DOUBLE: [(&str, Wrap); 4] = [
    ("**", Wrap::Bold),
    ("~~", Wrap::Strike),
    ("__", Wrap::Underline),
    ("==", Wrap::Highlight),
];

/// 1 行の中身（強調・コード・リンク・メンション・URL）を構文木にする
pub fn parse_inline(s: &str, depth: usize) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::new();
    let mut buf = String::new();
    let flush = |buf: &mut String, out: &mut Vec<Inline>| {
        if !buf.is_empty() {
            out.push(Inline::Text {
                text: std::mem::take(buf),
            });
        }
    };
    let bytes = s.as_bytes();
    let mut i = 0;
    'outer: while i < s.len() {
        if let Some(atom) = atom_at(s, i) {
            match atom {
                Atom::Node { len, node } => {
                    flush(&mut buf, &mut out);
                    out.push(node);
                    i += len;
                }
                Atom::Text { len, text } => {
                    buf.push_str(&text);
                    i += len;
                }
            }
            continue;
        }

        if depth < 8 {
            for (delim, kind) in DOUBLE {
                if !s[i..].starts_with(delim) {
                    continue;
                }
                match char_at(s, i + delim.len()) {
                    None => continue,
                    Some(c) if is_js_space(c) => continue,
                    _ => {}
                }
                if delim == "__" && char_before(s, i).is_some_and(is_word) {
                    continue;
                }
                let Some(j) = find_close(s, i + delim.len(), delim) else {
                    continue;
                };
                flush(&mut buf, &mut out);
                out.push(wrap(kind, parse_inline(&s[i + delim.len()..j], depth + 1)));
                i = j + delim.len();
                continue 'outer;
            }

            let c = bytes[i];
            let single = c == b'_' || (c == b'*' && bytes.get(i + 1) != Some(&b'*'));
            if single
                && let Some(next) = char_at(s, i + 1)
                && !is_js_space(next)
                && (c != b'_' || i == 0 || !char_before(s, i).is_some_and(is_word))
            {
                let delim = if c == b'_' { "_" } else { "*" };
                if let Some(j) = find_close(s, i + 1, delim) {
                    flush(&mut buf, &mut out);
                    out.push(Inline::Italic {
                        children: parse_inline(&s[i + 1..j], depth + 1),
                    });
                    i = j + 1;
                    continue;
                }
            }
        }

        let ch = char_at(s, i).unwrap_or('\u{fffd}');
        buf.push(ch);
        i += ch.len_utf8();
    }
    flush(&mut buf, &mut out);
    out
}

/// 通知などのプレーンテキスト用: メンションを `@名前` に置き換える
pub fn mentions_to_text(body: &str, name_of: impl Fn(&str) -> String) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < body.len() {
        if let Some((id, end)) = mention_at(body, i) {
            out.push('@');
            out.push_str(&name_of(id));
            i = end;
        } else {
            let ch = char_at(body, i).unwrap_or('\u{fffd}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// 本文に含まれるメンションの ID（出現順）
pub fn extract_mentions(body: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if let Some((id, end)) = mention_at(body, i) {
            ids.push(id.to_owned());
            i = end;
        } else {
            i += char_at(body, i).map_or(1, char::len_utf8);
        }
    }
    ids
}
