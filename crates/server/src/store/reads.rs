//! read_markers テーブル（既読の位置）。
//!
//! 場所（scope）はメインチャットの `''` だけ。
//! 行がない場所は、アカウントを作った時刻の位置（`baseline`）まで既読とみなす。

use disnans_shared::{ReadMarker, User};
use sqlx::SqlitePool;
use ulid::Ulid;

/// メインチャットの scope。
const MAIN: &str = "";

/// 既読の位置の行がない場所で使う位置。アカウントを作った時刻の ULID（ランダム部は 0）。
/// これより前に作られたメッセージは既読とみなす。
pub fn baseline(user: &User) -> String {
    Ulid::from_parts(user.created_at.max(0) as u64, 0).to_string()
}

#[derive(sqlx::FromRow)]
struct MarkerRow {
    last_read_id: String,
    unread_count: i64,
}

impl From<MarkerRow> for ReadMarker {
    fn from(row: MarkerRow) -> Self {
        ReadMarker {
            last_read_id: row.last_read_id,
            unread_count: row.unread_count as u32,
        }
    }
}

/// メインチャットの既読の位置と未読数。
/// 未読数は、既読の位置より新しい他人のメッセージの数（削除したものは行ごと消えるので数えない）。
pub async fn get(pool: &SqlitePool, user: &User) -> sqlx::Result<ReadMarker> {
    let row: MarkerRow = sqlx::query_as(
        "SELECT c.last_read_id,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.id > c.last_read_id
                   AND m.author_id != ?) AS unread_count
         FROM (SELECT MAX(COALESCE(
                   (SELECT last_read_id FROM read_markers WHERE user_id = ? AND scope = ?), ''), ?)
               AS last_read_id) c",
    )
    .bind(&user.id)
    .bind(&user.id)
    .bind(MAIN)
    .bind(baseline(user))
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

/// 既読の位置を進める。いまの位置より古い ID なら何もしない（戻さない）。
/// 位置が変わったら `true` を返す。
pub async fn advance(
    pool: &SqlitePool,
    user: &User,
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
    .bind(MAIN)
    .bind(message_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
