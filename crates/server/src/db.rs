//! SQLite の接続と、ID・時刻の生成。

use std::path::Path;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use disnans_shared::Timestamp;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use ulid::{Generator, Ulid};

/// DB を開き（なければ作り）、マイグレーションを適用する。
pub async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str("sqlite://")?
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// 新しい ULID を作る。
///
/// 同じミリ秒の中でも順番が保たれるよう、単調増加するジェネレーターを使う
/// （メッセージの ID はページングや並べ替えに使うため）。
pub fn new_ulid() -> Ulid {
    static GENERATOR: OnceLock<Mutex<Generator>> = OnceLock::new();
    let mut generator = GENERATOR
        .get_or_init(|| Mutex::new(Generator::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // 同じミリ秒に 2^80 個作るとあふれるが、現実には起きない。念のため普通の ULID にする
    generator.generate().unwrap_or_else(|_| Ulid::new())
}

pub fn new_id() -> String {
    new_ulid().to_string()
}

/// 現在時刻（Unix ミリ秒）。
pub fn now_ms() -> Timestamp {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Timestamp)
        .unwrap_or_default()
}
