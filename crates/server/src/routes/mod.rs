//! HTTP のルーティング。

mod files;
mod messages;
mod notify;
mod threads;
mod users;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::state::SharedState;
use crate::{auth, ws};

pub fn router(state: SharedState) -> Router {
    let api = Router::new()
        .route("/me", get(users::me).patch(users::update_me))
        .route("/users", get(users::list))
        .route("/messages", get(messages::list))
        .route("/threads", get(threads::list))
        .route("/threads/{id}", get(threads::get))
        // ファイルサイズの上限はなし（ストリーミングでディスクに書く）
        .route(
            "/files",
            post(files::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/files/{id}", get(files::get))
        .route("/files/{id}/thumb", get(files::thumb))
        .route("/notify/sample", post(notify::sample))
        .route("/ws", get(ws::handler))
        .fallback(|| async { AppError::not_found("API が見つかりません") })
        .layer(from_fn_with_state(state.clone(), auth::middleware));

    Router::new()
        .nest("/api", api)
        .layer(TraceLayer::new_for_http())
        // どのオリジンからのリクエストも許可する。開発中のフロントエンドや Tauri の WebView は
        // サーバーと別のオリジンになるため。認証はネットワーク（Tailscale）の層で行っており、
        // Cookie なども使わないので、オリジンを制限しても守れるものはない。
        .layer(CorsLayer::permissive())
        .with_state(state)
}
