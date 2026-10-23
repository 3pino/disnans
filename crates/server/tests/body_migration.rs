//! マイグレーション 0016（本文の埋め込みと初回投稿の時刻）の結合テスト。
//! 0015 までの DB に、投稿済み・削除済み・投稿前（library）の添付を入れてから `db::connect` で開く。

use std::path::Path;
use std::str::FromStr;

use disnans_server::db;
use sqlx::Row;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::from_str("sqlite://")
        .unwrap()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
}

async fn db_at_0015(dir: &Path) -> std::path::PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let old = dir.join("old-migrations");
    std::fs::create_dir_all(&old).unwrap();
    for entry in std::fs::read_dir(&src).unwrap() {
        let p = entry.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if name.as_str() < "0016" {
            std::fs::copy(&p, old.join(&name)).unwrap();
        }
    }
    let path = dir.join("disnans.db");
    let pool = SqlitePoolOptions::new()
        .connect_with(options(&path))
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(old.as_path())
        .await
        .unwrap()
        .run(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, login_name, display_name, created_at) VALUES ('u', 'alice', 'alice', 0)")
        .execute(&pool)
        .await
        .unwrap();
    for (id, at, body) in [("m1", 100i64, ""), ("m2", 200, "text")] {
        sqlx::query("INSERT INTO messages (id, author_id, body, created_at) VALUES (?, 'u', ?, ?)")
            .bind(id)
            .bind(body)
            .bind(at)
            .execute(&pool)
            .await
            .unwrap();
    }
    // (id, 投稿先, 位置, 名前, 削除, library)
    type Row<'a> = (&'a str, Option<&'a str>, i64, &'a str, Option<i64>, i64);
    let rows: [Row; 5] = [
        ("f1", Some("m1"), 0, "a.txt", None, 0),
        ("f3", Some("m1"), 1, "b.txt", None, 0),
        ("f2", Some("m2"), 0, "c.txt", None, 0),
        ("f4", Some("m2"), 1, "d.txt", Some(250), 0),
        ("f5", None, 0, "e.txt", None, 1),
    ];
    for (id, msg, pos, name, deleted, library) in rows {
        sqlx::query(
            "INSERT INTO files (id, uploader_id, message_id, position, file_name, mime, size, has_thumb, created_at, deleted_at, library)
             VALUES (?, 'u', ?, ?, ?, 'text/plain', 3, 0, 10, ?, ?)",
        )
        .bind(id)
        .bind(msg)
        .bind(pos)
        .bind(name)
        .bind(deleted)
        .bind(library)
        .execute(&pool)
        .await
        .unwrap();
    }
    pool.close().await;
    path
}

fn backups(dir: &Path) -> usize {
    std::fs::read_dir(dir.join("backup"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("pre-migrate-"))
                .count()
        })
        .unwrap_or(0)
}

async fn bodies(pool: &sqlx::SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as("SELECT id, body FROM messages ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn existing_attachments_become_embeds_once_and_keep_their_first_post_time() {
    let dir = tempfile::tempdir().unwrap();
    let path = db_at_0015(dir.path()).await;

    let pool = db::connect(&path).await.unwrap();
    assert_eq!(backups(dir.path()), 1, "移行の前に一度残す");
    assert_eq!(
        bodies(&pool).await,
        vec![
            (
                "m1".to_owned(),
                "![[disnans:file/f1]]\n![[disnans:file/f3]]".to_owned()
            ),
            (
                "m2".to_owned(),
                "text\n![[disnans:file/f2]]\n![[disnans:file/f4]]".to_owned()
            ),
        ]
    );
    let posted: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT id, first_posted_at FROM files ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        posted,
        vec![
            ("f1".into(), Some(100)),
            ("f2".into(), Some(200)),
            ("f3".into(), Some(100)),
            ("f4".into(), Some(200)),
            ("f5".into(), None),
        ]
    );
    pool.close().await;

    // もう一度開いても、何も変えない（バックアップも増えない）
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let pool = db::connect(&path).await.unwrap();
    assert_eq!(backups(dir.path()), 1);
    assert_eq!(bodies(&pool).await[0].1, "![[disnans:file/f1]]\n![[disnans:file/f3]]");
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM files WHERE first_posted_at IS NULL AND message_id IS NOT NULL")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(n, 0);
}
