//! 診断用の `GET /api/health`（認証なし）。サーバーが生きているか、DB に届くか、接続数を返す。
//! 個人情報は含めない（版・稼働秒数・DB の応答時間・接続中の WebSocket の数だけ）。

use std::time::Instant;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::state::SharedState;

pub async fn get(State(state): State<SharedState>) -> Response {
    let started = Instant::now();
    let db = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.pool)
        .await;
    let db_ms = started.elapsed().as_millis() as u64;
    let db_ok = db.is_ok();
    let body = json!({
        "ok": db_ok,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": state.started.elapsed().as_secs(),
        "db": { "ok": db_ok, "ms": db_ms },
        "ws_connections": state.hub.connection_count(),
    });
    let status = if db_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body)).into_response()
}
