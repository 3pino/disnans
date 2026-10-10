//! disnans のサーバー。API は `docs/API.md` を参照。

pub mod auth;
pub mod avatars;
pub mod calls;
pub mod chat;
pub mod config;
pub mod db;
pub mod error;
pub mod files;
pub mod hub;
pub mod image_proc;
pub mod notify;
pub mod plugins;
pub mod routes;
pub mod sessions;
pub mod state;
pub mod store;
pub mod tailscale;
pub mod ws;

use std::sync::Arc;

use axum::Router;

use crate::config::Config;
use crate::hub::Hub;
use crate::notify::WsNotifier;
use crate::state::{AppState, SharedState};

/// データディレクトリと DB を用意し、ルーターを作る。投稿されなかったファイルの掃除も始める。
///
/// サーバーは `into_make_service_with_connect_info::<SocketAddr>()` で動かすこと
/// （認証に接続元のアドレスを使う）。
pub async fn build(
    config: Config,
) -> Result<(Router, SharedState), Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(config.files_dir())?;
    std::fs::create_dir_all(config.plugins_dir())?;
    std::fs::create_dir_all(config.avatars_dir())?;
    // 前回の途中で残った一時ファイルは捨てる
    let _ = std::fs::remove_dir_all(config.tmp_dir());
    std::fs::create_dir_all(config.tmp_dir())?;

    let pool = db::connect(&config.db_path()).await?;
    let hub = Arc::new(Hub::new());
    let notifier = Arc::new(WsNotifier::new(hub.clone()));
    let state: SharedState = Arc::new(AppState::new(config, pool, hub, notifier));

    files::spawn_cleanup_task(state.clone());
    Ok((routes::router(state.clone()), state))
}
