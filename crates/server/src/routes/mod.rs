//! HTTP のルーティング。

mod devices;
mod files;
mod messages;
mod notify;
mod plugins;
mod reads;
mod sessions;
mod shared;
mod users;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn_with_state;
use axum::routing::{delete, get, post, put};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::state::SharedState;
use crate::{auth, ws};

pub fn router(state: SharedState) -> Router {
    let api = Router::new()
        .route("/me", get(users::me).patch(users::update_me))
        // 上限は画像の大きさに、multipart の見出しの分を足したもの
        .route(
            "/me/avatar",
            put(users::upload_avatar)
                .delete(users::delete_avatar)
                .layer(DefaultBodyLimit::max(
                    crate::avatars::MAX_UPLOAD_BYTES + 64 * 1024,
                )),
        )
        // 上限は設定の大きさに、少し余裕を足したもの（大きすぎるものは prefs_too_large で断る）
        .route(
            "/me/prefs",
            get(users::get_prefs)
                .put(users::put_prefs)
                .layer(DefaultBodyLimit::max(users::MAX_PREFS_BYTES * 2)),
        )
        // デバイスごとの設定（上限は設定の大きさに、少し余裕を足したもの）
        .route("/me/devices", get(devices::list))
        .route(
            "/me/devices/{device_id}",
            put(devices::put).delete(devices::delete),
        )
        .route(
            "/me/devices/{device_id}/prefs",
            get(devices::get_prefs)
                .put(devices::put_prefs)
                .layer(DefaultBodyLimit::max(users::MAX_PREFS_BYTES * 2)),
        )
        .route("/me/read", get(reads::list).put(reads::mark))
        .route("/users", get(users::list))
        .route("/avatars/{id}", get(users::avatar))
        .route("/messages", get(messages::list))
        .route("/messages/search", get(messages::search))
        // ファイルサイズの上限はなし（ストリーミングでディスクに書く）
        .route(
            "/files",
            post(files::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/files/{id}", get(files::get).delete(files::discard))
        .route("/files/{id}/thumb", get(files::thumb))
        // 共有フォルダ（WebDAV と同じ中身。パスは末尾の `{*path}`）
        .route("/shared", get(shared::list_root).post(shared::ops))
        .route(
            "/shared/{*path}",
            get(shared::get)
                .put(shared::put)
                .delete(shared::delete)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/notify/sample", post(notify::sample))
        // 上限はプラグインの合計サイズに、multipart の見出しの分を足したもの
        .route(
            "/plugins",
            get(plugins::list)
                .post(plugins::upload)
                .layer(DefaultBodyLimit::max(
                    crate::plugins::MAX_PACKAGE_BYTES + 64 * 1024,
                )),
        )
        .route("/plugins/{id}", delete(plugins::remove))
        .route("/plugins/{id}/files/{name}", get(plugins::file))
        .route("/plugins/{id}/notify", post(plugins::notify))
        .route("/plugins/{id}/messages", post(plugins::post_message))
        .route("/sessions", post(sessions::create))
        .route("/sessions/{id}", get(sessions::get).put(sessions::update))
        .route("/ws", get(ws::handler))
        .fallback(|| async { AppError::not_found("API が見つかりません") })
        .layer(from_fn_with_state(state.clone(), auth::middleware))
        // どのオリジンからのリクエストも許可する。開発中のフロントエンドや Tauri の WebView は
        // サーバーと別のオリジンになるため。認証はネットワーク（Tailscale）の層で行っており、
        // Cookie なども使わないので、オリジンを制限しても守れるものはない。
        // /dav には付けない（CORS の層は OPTIONS に自分で答えてしまい、WebDAV の DAV: や Allow を返せなくなる）。
        .layer(CorsLayer::permissive());

    Router::new()
        .nest("/api", api)
        .merge(crate::webdav::router(state.clone()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
