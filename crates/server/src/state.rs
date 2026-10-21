//! アプリケーション全体で共有する状態。

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{Mutex, MutexGuard};

use crate::calls::Calls;
use crate::config::Config;
use crate::hub::Hub;
use crate::notify::Notifier;
use crate::presence::Presence;
use crate::tailscale::Tailscale;
use crate::update::Restart;

pub struct AppState {
    pub config: Config,
    pub pool: SqlitePool,
    pub hub: Arc<Hub>,
    pub notifier: Arc<dyn Notifier>,
    /// 通話の参加者。
    pub calls: Calls,
    /// セッションを開いている人の一覧（メモリだけ）。
    pub presence: Presence,
    pub tailscale: Tailscale,
    /// 自動更新の入れ替えのあとの再起動の要求。
    pub restart: Restart,
    /// 書き込みを1つずつ行うためのロック。
    ///
    /// 少人数なので並列に書く必要はない。直列にすると SQLite のロックの競合を避けられ、
    /// さらに配信の順番も DB に書いた順番と一致する（ロックを持ったまま配信する）。
    write_lock: Mutex<()>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(
        config: Config,
        pool: SqlitePool,
        hub: Arc<Hub>,
        notifier: Arc<dyn Notifier>,
    ) -> Self {
        let tailscale = Tailscale::new(config.tailscale_socket.clone());
        Self {
            config,
            pool,
            hub,
            notifier,
            calls: Calls::new(),
            presence: Presence::default(),
            tailscale,
            restart: Restart::default(),
            write_lock: Mutex::new(()),
        }
    }

    pub async fn write_lock(&self) -> MutexGuard<'_, ()> {
        self.write_lock.lock().await
    }
}
