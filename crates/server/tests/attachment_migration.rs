//! マイグレーション 0015（添付の別名）の結合テスト。
//! 0014 までの形の DB に、同じ名前の添付（投稿済み・投稿前）を入れてから、本番と同じ `db::connect` で開く。

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

/// 0001〜0014 だけを適用した DB を作る（本番の 0014 の状態）。
async fn db_at_0014(dir: &Path) -> std::path::PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let old = dir.join("old-migrations");
    std::fs::create_dir_all(&old).unwrap();
    for entry in std::fs::read_dir(&src).unwrap() {
        let p = entry.unwrap().path();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if name.as_str() < "0015" {
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

    for (id, login) in [("u-alice", "alice"), ("u-bob", "bob")] {
        sqlx::query(
            "INSERT INTO users (id, login_name, display_name, created_at) VALUES (?, ?, ?, 0)",
        )
        .bind(id)
        .bind(login)
        .bind(login)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (id, at) in [("m1", 100i64), ("m2", 200), ("m3", 300)] {
        sqlx::query(
            "INSERT INTO messages (id, author_id, body, created_at) VALUES (?, 'u-alice', 'x', ?)",
        )
        .bind(id)
        .bind(at)
        .execute(&pool)
        .await
        .unwrap();
    }
    // (id, 投稿先, 作成, 名前)。投稿の順は m1 → m2 → m3。投稿前は 50 と 60。
    let rows = [
        ("f1", Some("m1"), 10i64, "a.txt"),
        ("f2", Some("m2"), 20, "A.TXT"),
        ("f3", Some("m3"), 30, "a.txt"),
        ("f4", None, 50, "a.txt"),
        ("f5", None, 60, "c.txt"),
    ];
    for (id, msg, created, name) in rows {
        sqlx::query(
            "INSERT INTO files (id, uploader_id, message_id, position, file_name, mime, size, has_thumb, created_at)
             VALUES (?, 'u-alice', ?, 0, ?, 'text/plain', 3, 0, ?)",
        )
        .bind(id)
        .bind(msg)
        .bind(name)
        .bind(created)
        .execute(&pool)
        .await
        .unwrap();
    }
    pool.close().await;
    path
}

async fn names(pool: &sqlx::SqlitePool) -> Vec<(String, String, Option<String>)> {
    sqlx::query("SELECT id, file_name, alias_key FROM files ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.get("id"), r.get("file_name"), r.get("alias_key")))
        .collect()
}

#[tokio::test]
async fn existing_names_are_numbered_in_posting_order_and_the_result_is_stable() {
    let dir = tempfile::tempdir().unwrap();
    let path = db_at_0014(dir.path()).await;

    // 本番と同じ起動（マイグレーションと別名の割り当て）
    let pool = db::connect(&path).await.unwrap();
    let after = names(&pool).await;
    let get = |id: &str| after.iter().find(|r| r.0 == id).unwrap().clone();

    // 投稿済み: 投稿の古い順。最初はそのまま、後は (2)、(3)
    assert_eq!(get("f1").1, "a.txt");
    assert_eq!(get("f2").1, "A (2).TXT");
    assert_eq!(get("f3").1, "a (3).txt");
    // 投稿前は投稿済みの後。同じ名前は (4)、違う名前はそのまま
    assert_eq!(get("f4").1, "a (4).txt");
    assert_eq!(get("f5").1, "c.txt");
    // すべての行に比較のキーが入る
    assert!(after.iter().all(|r| r.2.is_some()), "{after:?}");

    // 一意インデックスができている
    let idx: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'files_live_alias'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(idx.is_some());
    pool.close().await;

    // もう一度開いても、名前は変わらない（冪等）
    let pool = db::connect(&path).await.unwrap();
    assert_eq!(names(&pool).await, after);
    pool.close().await;
}

#[tokio::test]
async fn an_index_rejects_two_live_files_with_the_same_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = db_at_0014(dir.path()).await;
    let pool = db::connect(&path).await.unwrap();
    let err = sqlx::query(
        "INSERT INTO files (id, uploader_id, file_name, alias_key, mime, size, has_thumb, created_at)
         VALUES ('dup', 'u-alice', 'a.txt', 'a.txt', 'text/plain', 1, 0, 1)",
    )
    .execute(&pool)
    .await;
    assert!(err.is_err(), "同じ別名の生きている添付は入らない");
}
