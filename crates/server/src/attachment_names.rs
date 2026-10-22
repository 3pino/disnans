//! 添付の別名（`attachments/` での名前）。
//!
//! 別名は `files.file_name` に入り、生きている添付の中で大文字小文字を区別せず一意。
//! 比較のキーは `files.alias_key`（Unicode の小文字化）。一意性は DB の部分インデックスでも守る。
//! 同名があれば `name (2).ext`、`name (3).ext`…（Windows 流）。
//!
//! 既存の行の別名は、起動時の [`backfill`] で割り当てる（マイグレーションの SQL では Unicode の小文字化が
//! できないため Rust で行う）。冪等: `alias_key` が無い行だけを処理する。

use std::collections::HashSet;

use sqlx::SqlitePool;

/// 名前の幹の最大の文字数（番号を足しても 255 バイトに収まるように）。
const MAX_STEM_CHARS: usize = 180;

/// 比較のキー（大文字小文字を区別しない）。
pub fn key(name: &str) -> String {
    name.to_lowercase()
}

/// 幹と拡張子に分ける。拡張子は最後の `.` の後ろ（先頭の `.` だけの名前は拡張子なし）。
fn split(base: &str) -> (&str, &str) {
    match base.rfind('.') {
        Some(p) if p > 0 => (&base[..p], &base[p..]),
        _ => (base, ""),
    }
}

/// `base` の n 番目の候補（`name (n).ext`）。n は 2 から。
pub fn numbered(base: &str, n: usize) -> String {
    let (stem, ext) = split(base);
    let stem: String = stem.chars().take(MAX_STEM_CHARS).collect();
    format!("{stem} ({n}){ext}")
}

/// `taken(key)` が真の名前を避けて、`base` に近い一意な名前を返す。`taken` は比較のキーで聞く。
pub fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(&key(base)) {
        return base.to_owned();
    }
    let mut n = 2usize;
    loop {
        let candidate = numbered(base, n);
        if !taken(&key(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// 既存の行に別名を割り当てる（`alias_key` が無い行だけ）。投稿の古い順、次に投稿されていないものを作成の順。
/// 1 つのトランザクションで行い、一意インデックスを作る。戻り値は割り当てた件数。
pub async fn backfill(pool: &SqlitePool) -> sqlx::Result<usize> {
    let mut tx = pool.begin().await?;
    let mut taken: HashSet<String> = sqlx::query_scalar(
        "SELECT alias_key FROM files WHERE alias_key IS NOT NULL AND deleted_at IS NULL",
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    let todo: Vec<(String, String)> = sqlx::query_as(
        "SELECT f.id, f.file_name FROM files f LEFT JOIN messages m ON m.id = f.message_id
         WHERE f.alias_key IS NULL
         ORDER BY m.created_at IS NULL, m.created_at, m.id, f.position, f.created_at, f.id",
    )
    .fetch_all(&mut *tx)
    .await?;

    let count = todo.len();
    for (id, file_name) in todo {
        let name = unique(&file_name, |k| taken.contains(k));
        let k = key(&name);
        sqlx::query("UPDATE files SET file_name = ?, alias_key = ? WHERE id = ?")
            .bind(&name)
            .bind(&k)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        taken.insert(k);
    }
    // 一意インデックスは移行の SQL で作っている（冪等のため、ここでは作らない）
    tx.commit().await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_name_when_free_and_numbers_it_otherwise() {
        let none = |_: &str| false;
        assert_eq!(unique("report.txt", none), "report.txt");
        let taken = |k: &str| k == "report.txt";
        assert_eq!(unique("report.txt", taken), "report (2).txt");
        let taken2 = |k: &str| k == "report.txt" || k == "report (2).txt";
        assert_eq!(unique("report.txt", taken2), "report (3).txt");
        assert_eq!(unique("noext", |k| k == "noext"), "noext (2)");
        assert_eq!(unique(".hidden", |k| k == ".hidden"), ".hidden (2)");
    }

    #[test]
    fn the_key_ignores_case_and_follows_unicode() {
        assert_eq!(key("Photo.PNG"), key("photo.png"));
        assert_eq!(key("Ä.txt"), key("ä.txt"));
        let taken = |k: &str| k == key("ä.txt");
        assert_eq!(unique("Ä.txt", taken), "Ä (2).txt");
    }

    #[test]
    fn long_stems_are_cut_before_the_number() {
        let base = format!("{}.txt", "a".repeat(250));
        let out = unique(&base, |k| k == key(&base));
        assert!(out.ends_with(" (2).txt"), "{out}");
        assert!(out.len() < 200, "{}", out.len());
    }
}
