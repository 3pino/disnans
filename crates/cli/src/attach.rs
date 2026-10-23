//! 本文のリンクと添付の突き合わせ。本文が真実で、`Message.attachments` は本文の埋め込みから導かれるため、
//! 本文のリンクで示された添付を、別の「添付」行として二重に出さないために使う。

use disnans_client_core::view::markdown::{self, Block, Inline};

/// 本文のリンク（`![[attachments/名前]]` など、埋め込みでなくても）が指す `attachments/` の名前。
pub fn linked_names(body: &str) -> Vec<String> {
    fn inlines(items: &[Inline], out: &mut Vec<String>) {
        for item in items {
            match item {
                Inline::FileLink { path, .. } => {
                    if let Some(name) = path.strip_prefix("attachments/") {
                        out.push(name.to_lowercase());
                    }
                }
                Inline::Bold { children }
                | Inline::Italic { children }
                | Inline::Underline { children }
                | Inline::Strike { children }
                | Inline::Highlight { children } => inlines(children, out),
                _ => {}
            }
        }
    }
    fn walk(list: &[Block], out: &mut Vec<String>) {
        for block in list {
            match block {
                Block::Paragraph { lines } => lines.iter().for_each(|l| inlines(l, out)),
                Block::Quote { children } => walk(children, out),
                Block::List { items, .. } => {
                    for item in items {
                        item.lines.iter().for_each(|l| inlines(l, out));
                        walk(&item.children, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(&markdown::parse(body), &mut out);
    out
}

/// 添付が本文のリンクで示されているか（名前は大文字小文字を区別しない）。
pub fn is_linked(linked: &[String], file_name: &str) -> bool {
    let name = file_name.to_lowercase();
    linked.contains(&name)
}

/// 返信先の要約など、短く切られた本文の表示用。埋め込み（`![[…]]`、途中で切れたものも）を `[添付: 名前]` にする。
pub fn plain_excerpt(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("![[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        let (inner, tail) = match after.find("]]") {
            Some(end) => (&after[..end], &after[end + 2..]),
            None => (after, ""),
        };
        let path = inner.split('|').next().unwrap_or("");
        let name = path.rsplit('/').next().unwrap_or(path);
        out.push_str(&format!("[添付: {name}]"));
        rest = tail;
    }
    out.push_str(rest);
    out.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_linked_attachment_names_but_not_code() {
        let body = "見て ![[attachments/Photo.png]] と [x](attachments/a b.txt)\n`![[attachments/no.png]]`";
        let names = linked_names(body);
        assert_eq!(names, ["photo.png", "a b.txt"]);
        assert!(is_linked(&names, "PHOTO.png"));
        assert!(!is_linked(&names, "no.png"));
    }

    #[test]
    fn excerpt_replaces_embeds_even_when_cut() {
        assert_eq!(plain_excerpt("![[attachments/x.png]]"), "[添付: x.png]");
        assert_eq!(
            plain_excerpt("a ![[attachments/x.png|表]] b"),
            "a [添付: x.png] b"
        );
        assert_eq!(plain_excerpt("hi ![[attachments/lo"), "hi [添付: lo]");
    }
}
