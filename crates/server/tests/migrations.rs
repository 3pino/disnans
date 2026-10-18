//! マイグレーション 0012（スレッドの廃止）と、適用の前のバックアップの結合テスト。

use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

const M1: &str = "01A000000000000000000000M1";
const M2: &str = "01A000000000000000000000M2";
const M3: &str = "01A000000000000000000000Z3"; // R1・R2 より後（ID の順＝時刻順）
const R1: &str = "01A000000000000000000000R1";
const R2: &str = "01A000000000000000000000R2";

async fn open(path: &std::path::Path) -> SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .unwrap()
}

/// 0012 の手前（0011 まで）の DB を作り、ユーザーとメッセージを入れる。
async fn old_db(path: &std::path::Path) -> SqlitePool {
    let pool = open(path).await;
    let all = sqlx::migrate!("./migrations");
    let mut before = Migrator::DEFAULT;
    before.migrations = all
        .migrations
        .iter()
        .filter(|m| m.version < 12)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();

    for (id, login) in [("U1", "alice@test"), ("U2", "bob@test")] {
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
    // M1・M2・M3 はメインチャット。M2 が起点のスレッドに R1（返信先なし）と R2（返信先 M1）
    let rows = [
        (M1, "U1", None, None),
        (M2, "U2", None, None),
        (R1, "U1", Some(M2), None),
        (R2, "U2", Some(M2), Some(M1)),
        (M3, "U1", None, None),
    ];
    for (id, author, thread, reply_to) in rows {
        sqlx::query(
            "INSERT INTO messages (id, author_id, thread_id, reply_to, body, created_at)
             VALUES (?, ?, ?, ?, 'x', 0)",
        )
        .bind(id)
        .bind(author)
        .bind(thread)
        .bind(reply_to)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO threads (id, created_at) VALUES (?, 0)")
        .bind(M2)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO thread_tags (thread_id, position, label, icon) VALUES (?, 0, 'todo', NULL)",
    )
    .bind(M2)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO read_markers (user_id, scope, last_read_id, updated_at) VALUES ('U1', ?, ?, 0)")
        .bind(M2)
        .bind(R1)
        .execute(&pool)
        .await
        .unwrap();
    pool
}

#[tokio::test]
async fn thread_replies_move_to_the_main_chat_with_their_context() {
    let dir = tempfile::tempdir().unwrap();
    let pool = old_db(&dir.path().join("db.sqlite")).await;

    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    // 時刻順（ID の順）は保たれ、どれもメインチャットになる。返信先のないものは起点への返信になる
    let rows: Vec<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, thread_id, reply_to FROM messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let expected = vec![
        (M1.to_owned(), None, None),
        (M2.to_owned(), None, None),
        (R1.to_owned(), None, Some(M2.to_owned())),
        (R2.to_owned(), None, Some(M1.to_owned())),
        (M3.to_owned(), None, None),
    ];
    assert_eq!(rows, expected);

    // スレッドの表・タグ・スレッドの既読は消える。メインチャットの既読は残る
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'thread_tags')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
    let scoped: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM read_markers WHERE scope <> ''")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(scoped, 0);
}

#[tokio::test]
async fn pending_migrations_back_up_the_database_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("disnans.db");
    let pool = old_db(&path).await;
    pool.close().await;

    let db = disnans_server::db::connect(&path).await.unwrap();
    db.close().await;

    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backup"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert!(backups[0].starts_with("pre-migrate-"), "{backups:?}");

    // バックアップは移行の前の中身を持つ（スレッドの表がまだある）
    let backup = open(&dir.path().join("backup").join(&backups[0])).await;
    let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
        .fetch_one(&backup)
        .await
        .unwrap();
    assert_eq!(threads, 1);
}

#[tokio::test]
async fn a_current_database_is_not_backed_up_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("disnans.db");
    disnans_server::db::connect(&path)
        .await
        .unwrap()
        .close()
        .await;
    // 2 回目は、適用するものがないのでバックアップを取らない
    disnans_server::db::connect(&path)
        .await
        .unwrap()
        .close()
        .await;
    assert!(!dir.path().join("backup").exists());
}
