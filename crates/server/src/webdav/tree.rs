//! `attachments/` の仮想フォルダの中身。
//!
//! 共有フォルダ（`/dav/` の直下）の中に、`attachments/` を見せる。中身は `attachments/<別名>`。
//! 別名は添付ごとに 1 つで、アップロードの時に決まる（`attachment_names`）。生きている添付の中で一意なので、
//! ここでは名前の衝突を処理しない。
//!
//! ここは DB に触らない純粋な計算だけ（呼び出し側が [`Item`] を集める）。

/// 仮想フォルダの名前（共有フォルダの直下）。消せず、名前も変えられない。
pub const ATTACHMENTS_DIR: &str = "attachments";

/// `attachments/` の 1 つの添付。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub file_id: String,
    /// 別名（`attachments/` での名前）。
    pub name: String,
    pub size: u64,
    /// 投稿の時刻（投稿されていないもの＝直接作ったものは作成の時刻）。ミリ秒、UNIX 時間。
    pub posted_at_ms: i64,
    /// 添付したメッセージの ID（直接作ったものは無い）。
    pub message_id: Option<String>,
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

/// 並びは投稿の時刻と ID（同じ時刻でも順番が変わらないように）。
fn files(items: &[Item]) -> Vec<Child<'_>> {
    let mut picked: Vec<&Item> = items.iter().collect();
    picked.sort_by(|a, b| (a.posted_at_ms, &a.file_id).cmp(&(b.posted_at_ms, &b.file_id)));
    picked
        .into_iter()
        .map(|item| Child {
            name: item.name.clone(),
            entry: Entry::File(item),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, name: &str, at: i64) -> Item {
        Item {
            file_id: id.into(),
            name: name.into(),
            size: 1,
            posted_at_ms: at,
            message_id: Some(format!("m-{id}")),
            mime: "text/plain".into(),
        }
    }

    #[test]
    fn names_are_the_stored_names_in_posting_order() {
        let items = vec![item("b", "same.txt", 2), item("a", "same (2).txt", 1)];
        let names: Vec<String> = children(&items, &["attachments"])
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["same (2).txt", "same.txt"]);
    }

    #[test]
    fn only_the_root_and_attachments_exist() {
        let items = vec![item("a", "x.txt", 1)];
        assert!(find(&items, &["attachments", "x.txt"]).is_some());
        assert!(find(&items, &["attachments", "nope"]).is_none());
        assert!(children(&items, &["docs"]).is_none());
        assert!(children(&items, &["attachments", "x.txt"]).is_none());
    }
}
