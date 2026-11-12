//! 結合テスト用の、開発モードのサーバー（一時ディレクトリで起動する）。
//! `test-support` の機能でだけ入る。本番のバイナリには入らない。

use std::net::SocketAddr;
use std::path::PathBuf;

use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::state::SharedState;

/// 開発モードのサーバー。`addr` で待ち受けていて、`dir` は一時ディレクトリ（終わると消える）。
/// 落ちたら（drop で）止まる。SQLite を確実に閉じてから消したいときは `stop` を呼ぶ。
pub struct DevServer {
    pub addr: SocketAddr,
    pub state: SharedState,
    pub dir: tempfile::TempDir,
    task: JoinHandle<()>,
}

impl DevServer {
    /// 新しい一時ディレクトリにデータを置いて、ランダムな空きポートで起動する。
    /// ユーザーは `X-Dev-User` で決める（whois は使わない）。
    pub async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_owned();
        Self::start_on(data_dir, dir).await
    }

    /// 指定のデータフォルダで起動する（再起動の試験用）。`dir` はこのサーバーが持つ一時ディレクトリ。
    pub async fn start_on(data_dir: PathBuf, dir: tempfile::TempDir) -> Self {
        let config = Config {
            data_dir,
            bind: "127.0.0.1:0".parse().unwrap(),
            dev: true,
            tailscale_socket: dir.path().join("no-such-socket"),
            image_max_edge: crate::image_proc::DEFAULT_MAX_EDGE,
        };
        let (app, state) = crate::build(config).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            addr,
            state,
            dir,
            task,
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// 止めてから SQLite の接続を閉じる（Windows では、開いたままだと一時ディレクトリを消せない）。
    pub async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
        self.state.pool.close().await;
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
