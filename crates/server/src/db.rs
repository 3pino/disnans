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

    let migrator = sqlx::migrate!("./migrations");
    // 移行で消えるものがあるかもしれないので、適用の前に DB をまるごと残す（data/backup/）
    if has_pending_migrations(&pool, &migrator).await? {
        backup_before_migrate(&pool, path).await?;
    }
    migrator.run(&pool).await?;
    // 既存の添付に別名を割り当てる（冪等。割り当てる行が無ければ何もしない）
    let assigned = crate::attachment_names::backfill(&pool).await?;
    if assigned > 0 {
        tracing::info!("添付の別名を {assigned} 件割り当てました");
    }
    Ok(pool)
}

/// まだ適用していないマイグレーションがあるか。新しい DB（履歴の表がない）は移すデータがないので `false`。
async fn has_pending_migrations(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> Result<bool, sqlx::Error> {
    let table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?;
    if table.is_none() {
        return Ok(false);
    }
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = 1")
            .fetch_all(pool)
            .await?;
    Ok(migrator.iter().any(|m| !applied.contains(&m.version)))
}

/// 適用の前の DB を `<データ>/backup/pre-migrate-<時刻>.db` にコピーする（VACUUM INTO）。
/// 失敗したら起動を止める（バックアップなしで移行しない）。
async fn backup_before_migrate(pool: &SqlitePool, path: &Path) -> Result<(), sqlx::Error> {
    let dir = path.parent().unwrap_or(Path::new(".")).join("backup");
    std::fs::create_dir_all(&dir).map_err(sqlx::Error::Io)?;
    let file = dir.join(format!("pre-migrate-{}.db", now_ms()));
    // VACUUM INTO は引数に式を取る。パスの ' は二つに直して文字列リテラルにする
    let literal = file.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{literal}'"))
        .execute(pool)
        .await?;
    tracing::info!(backup = %file.display(), "マイグレーションの前に DB をバックアップしました");
    Ok(())
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
