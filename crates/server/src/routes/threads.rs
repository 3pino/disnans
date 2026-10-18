//! `/api/threads`（スレッドは廃止した）。古いクライアントが呼んだときに分かるよう、すべて `410 Gone` を返す。
//! 期限は決めず、いずれ routes/mod.rs ごと消す。

use axum::http::StatusCode;

use crate::error::AppError;

pub async fn gone() -> AppError {
    AppError::new(
        StatusCode::GONE,
        "threads_removed",
        "スレッドは廃止しました",
    )
}
