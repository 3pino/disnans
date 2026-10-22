//! `attachments/` の仮想フォルダの中身。
//!
//! 共有フォルダ（`/dav/` の直下）の中に、消せない読み取り専用の `attachments/` を見せる。
//! 中身は投稿された添付（メッセージに付いたファイル）だけで、平らに並べる: `attachments/<ファイル名>`。
//! 同じ名前（大文字小文字を区別しない）が複数あるときは、全部に末尾 8 文字の ID を付ける（`photo (RSTVWXYZ).png`）。
//! 重なれば ID 全体を使う。
//!
//! ここは DB に触らない純粋な計算だけ（呼び出し側が [`Item`] を集める）。

use std::collections::{HashMap, HashSet};

use crate::files::sanitize_file_name;

/// 仮想フォルダの名前（共有フォルダの直下）。消せず、中身も変えられない。
pub const ATTACHMENTS_DIR: &str = "attachments";
/// 同じ名前が続いたときに付ける ID の文字数（末尾から）。
const SHORT_ID_CHARS: usize = 8;
/// 名前の幹の最大の文字数（拡張子を足しても Windows の 255 文字に収まるように）。
const MAX_STEM_CHARS: usize = 180;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub file_id: String,
    pub file_name: String,
    pub size: u64,
    /// 投稿（メッセージの作成）の時刻（ミリ秒、UNIX 時間）。
    pub posted_at_ms: i64,
    /// 添付したメッセージの ID。
    pub message_id: String,
    /// 添付の種類（MIME）。
    pub mime: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Entry<'a> {
    Dir,
    File(&'a Item),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Child<'a> {
    pub name: String,
    pub entry: Entry<'a>,
}

/// `segments`（共有フォルダからのパス。空なら共有フォルダ）の中身を列挙する。
/// 存在しない・フォルダでない（ファイルの中など）ときは None。直下は `attachments` だけ。
pub fn children<'a>(items: &'a [Item], segments: &[&str]) -> Option<Vec<Child<'a>>> {
    match segments {
        [] => Some(vec![Child {
            name: ATTACHMENTS_DIR.into(),
            entry: Entry::Dir,
        }]),
        [root] if *root == ATTACHMENTS_DIR => Some(files(items)),
        _ => None,
    }
}

/// `segments` の 1 つを探す（フォルダでもファイルでもよい）。
pub fn find<'a>(items: &'a [Item], segments: &[&str]) -> Option<Entry<'a>> {
    let Some((last, parent)) = segments.split_last() else {
        return Some(Entry::Dir);
    };
    children(items, parent)?
        .into_iter()
        .find(|c| c.name == *last)
        .map(|c| c.entry)
}

fn files(items: &[Item]) -> Vec<Child<'_>> {
    let mut picked: Vec<&Item> = items.iter().collect();
    // 並びを決めておく（同じ時刻でも ID で順番が変わらないように）
    picked.sort_by(|a, b| (a.posted_at_ms, &a.file_id).cmp(&(b.posted_at_ms, &b.file_id)));
    let names = display_names(&picked);
    names
        .into_iter()
        .zip(picked)
        .map(|(name, item)| Child {
            name,
            entry: Entry::File(item),
        })
        .collect()
}

/// フォルダの中の表示名。同じ名前（大文字小文字を区別しない）が複数あれば、全部に ID の一部を付ける。
/// それでも重なるときは ID 全体を付ける（ID は一意なので重ならない）。
pub fn display_names(items: &[&Item]) -> Vec<String> {
    let bases: Vec<String> = items
        .iter()
        .map(|i| sanitize_file_name(Some(&i.file_name)))
        .collect();
    let mut count: HashMap<String, usize> = HashMap::new();
    for b in &bases {
        *count.entry(b.to_lowercase()).or_default() += 1;
    }
    let mut names: Vec<String> = items
        .iter()
        .zip(&bases)
        .map(|(item, base)| {
            if count[&base.to_lowercase()] > 1 {
                with_id(base, short_id(&item.file_id))
            } else {
                base.clone()
            }
        })
        .collect();
    // 短い ID でも重なったら、ID 全体を使う
    let mut seen: HashSet<String> = HashSet::new();
    let dupes: HashSet<String> = {
        let mut d = HashSet::new();
        for n in &names {
            if !seen.insert(n.to_lowercase()) {
                d.insert(n.to_lowercase());
            }
        }
        d
    };
    for ((name, item), base) in names.iter_mut().zip(items).zip(&bases) {
        if dupes.contains(&name.to_lowercase()) {
            *name = with_id(base, &item.file_id);
        }
    }
    names
}

fn short_id(id: &str) -> &str {
    let chars: Vec<(usize, char)> = id.char_indices().collect();
    match chars.len().checked_sub(SHORT_ID_CHARS) {
        Some(n) => &id[chars[n].0..],
        None => id,
    }
}

/// `名前 (ID).拡張子` の形にする。拡張子は最後の `.` の後ろ（先頭の `.` だけの名前は拡張子なし）。
fn with_id(base: &str, id: &str) -> String {
    let (stem, ext) = match base.rfind('.') {
        Some(p) if p > 0 => (&base[..p], &base[p..]),
        _ => (base, ""),
    };
    let stem: String = stem.chars().take(MAX_STEM_CHARS).collect();
    format!("{stem} ({id}){ext}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, posted_at_ms: i64) -> Item {
        Item {
            file_id: id.into(),
            file_name: name.into(),
            size: 1,
            posted_at_ms,
            message_id: format!("m-{id}"),
            mime: "text/plain".into(),
        }
    }

    const T0: i64 = 1_704_034_800_000;

    fn names(children: Vec<Child<'_>>) -> Vec<String> {
        children.into_iter().map(|c| c.name).collect()
    }

    #[test]
    fn shared_folder_has_only_attachments() {
        let items = vec![item("a", "x.png", T0)];
        assert_eq!(names(children(&items, &[]).unwrap()), vec!["attachments"]);
        assert_eq!(find(&items, &[]), Some(Entry::Dir));
        assert!(
            children(&items, &["other"]).is_none(),
            "直下は attachments だけ"
        );
    }

    #[test]
    fn attachments_are_one_flat_list_in_posting_order() {
        let items = vec![
            item("b", "b.png", T0 + 5),
            item("a", "a.png", T0),
            item("c", "c.png", T0 - 400 * 86_400_000),
        ];
        assert_eq!(
            names(children(&items, &["attachments"]).unwrap()),
            vec!["c.png", "a.png", "b.png"]
        );
        assert!(
            children(&items, &["attachments", "2024"]).is_none(),
            "年の分け方はない"
        );
    }

    #[test]
    fn same_name_gets_an_id_suffix() {
        let items = vec![
            item("01HXABCDEFGHJKMNPQRSTVWXYZ", "photo.png", T0),
            item("01HXZZZZZZZZZZZZZZZZZZZZZZ", "Photo.PNG", T0 + 1000),
            item("01HXABCDEFGHJKMNPQRSTVWX00", "notes.txt", T0 + 2000),
        ];
        let got = names(children(&items, &["attachments"]).unwrap());
        // 同じ名前（大文字小文字を区別しない）は、両方に末尾 8 文字の ID を付ける。それ以外はそのまま
        assert_eq!(
            got,
            vec!["photo (RSTVWXYZ).png", "Photo (ZZZZZZZZ).PNG", "notes.txt"]
        );
    }

    #[test]
    fn same_short_id_falls_back_to_the_full_id() {
        let a = "AAAAAAAAAAAAAAAAAAAAAAAA00000001";
        let b = "BBBBBBBBBBBBBBBBBBBBBBBB00000001";
        let items = vec![item(a, "doc.pdf", T0), item(b, "doc.pdf", T0 + 1)];
        let got = names(children(&items, &["attachments"]).unwrap());
        assert_eq!(
            got,
            vec![format!("doc ({a}).pdf"), format!("doc ({b}).pdf")]
        );
    }

    #[test]
    fn unsafe_names_are_sanitized_and_dotfiles_keep_their_name() {
        let items = vec![
            item("a", "../../etc/passwd", T0),
            item("b", ".bashrc", T0 + 1),
        ];
        let got = names(children(&items, &["attachments"]).unwrap());
        assert_eq!(got, vec!["passwd".to_owned(), ".bashrc".to_owned()]);
        assert!(!got.iter().any(|n| n.contains('/')));
    }

    #[test]
    fn long_names_stay_within_the_limit_when_suffixed() {
        let long = format!("{}.png", "あ".repeat(200));
        let items = vec![
            item("01HXABCDEFGHJKMNPQRSTVWXYZ", &long, T0),
            item("01HXABCDEFGHJKMNPQRSTVWXQQ", &long, T0 + 1),
        ];
        for n in names(children(&items, &["attachments"]).unwrap()) {
            assert!(n.chars().count() <= 200, "{n}");
        }
    }

    #[test]
    fn files_are_leaves_and_paths_must_be_exact() {
        let items = vec![item("a", "a.png", T0)];
        assert_eq!(
            find(&items, &["attachments", "a.png"]),
            Some(Entry::File(&items[0]))
        );
        assert!(children(&items, &["attachments", "a.png"]).is_none());
        assert!(find(&items, &["attachments", "A.PNG"]).is_none());
        assert!(find(&items, &["attachments", ".."]).is_none());
    }

    #[test]
    fn only_items_passed_in_are_listed() {
        let posted = vec![item("a", "a.png", T0)];
        assert_eq!(
            names(children(&posted, &["attachments"]).unwrap()),
            vec!["a.png"]
        );
    }
}
