//! read_markers テーブル（既読の位置）。
//!
//! 場所（scope）はメインチャットなら `''`、スレッドならスレッドの ID。
//! 行がない場所は、アカウントを作った時刻の位置（`baseline`）まで既読とみなす。

use disnans_shared::{ReadMarker, User};
use sqlx::SqlitePool;
use ulid::Ulid;

/// メインチャットの scope。
const MAIN: &str = "";

fn scope_of(thread_id: Option<&str>) -> &str {
    thread_id.unwrap_or(MAIN)
}

/// 既読の位置の行がない場所で使う位置。アカウントを作った時刻の ULID（ランダム部は 0）。
/// これより前に作られたメッセージは既読とみなす。
pub fn baseline(user: &User) -> String {
    Ulid::from_parts(user.created_at.max(0) as u64, 0).to_string()
}

#[derive(sqlx::FromRow)]
struct MarkerRow {
    scope: String,
    last_read_id: String,
    unread_count: i64,
}

impl From<MarkerRow> for ReadMarker {
    fn from(row: MarkerRow) -> Self {
        ReadMarker {
            thread_id: (row.scope != MAIN).then_some(row.scope),
            last_read_id: row.last_read_id,
            unread_count: row.unread_count as u32,
        }
    }
}

/// 既読の位置と未読数。`only` を指定するとその場所だけ、`None` ならメインチャットとすべてのスレッド
/// （メインチャットが先頭、スレッドは ID 順）。
/// 未読数は、既読の位置より新しい他人のメッセージの数（削除したものは行ごと消えるので数えない）。
async fn query(
    pool: &SqlitePool,
    user: &User,
    only: Option<Option<&str>>,
) -> sqlx::Result<Vec<ReadMarker>> {
    let rows: Vec<MarkerRow> = sqlx::query_as(
        "WITH scopes (scope) AS (
             SELECT '' UNION ALL SELECT id FROM threads
         ),
         cursors AS (
             SELECT s.scope, MAX(COALESCE(r.last_read_id, ''), ?) AS last_read_id
             FROM scopes s
             LEFT JOIN read_markers r ON r.user_id = ? AND r.scope = s.scope
             WHERE ? IS NULL OR s.scope = ?
         )
         SELECT c.scope, c.last_read_id,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.thread_id IS NULLIF(c.scope, '')
                   AND m.id > c.last_read_id
                   AND m.author_id != ?) AS unread_count
         FROM cursors c
         ORDER BY c.scope",
    )
    .bind(baseline(user))
    .bind(&user.id)
    .bind(only.map(scope_of))
    .bind(only.map(scope_of))
    .bind(&user.id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// メインチャットとすべてのスレッドの既読の位置と未読数。
pub async fn list(pool: &SqlitePool, user: &User) -> sqlx::Result<Vec<ReadMarker>> {
    query(pool, user, None).await
}

/// 1か所の既読の位置と未読数。スレッドがなければ `None`。
pub async fn get(
    pool: &SqlitePool,
    user: &User,
    thread_id: Option<&str>,
) -> sqlx::Result<Option<ReadMarker>> {
    Ok(query(pool, user, Some(thread_id)).await?.pop())
}

/// 既読の位置を進める。いまの位置より古い ID なら何もしない（戻さない）。
/// 位置が変わったら `true` を返す。
pub async fn advance(
    pool: &SqlitePool,
    user: &User,
    thread_id: Option<&str>,
    message_id: &str,
    now: i64,
) -> sqlx::Result<bool> {
    // 行がなければ baseline の位置にいるとみなすので、それ以下なら書かない
    if message_id <= baseline(user).as_str() {
        return Ok(false);
    }
    let res = sqlx::query(
        "INSERT INTO read_markers (user_id, scope, last_read_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, scope) DO UPDATE
         SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at
         WHERE excluded.last_read_id > read_markers.last_read_id",
    )
    .bind(&user.id)
    .bind(scope_of(thread_id))
    .bind(message_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
