//! 環境変数から読み込む設定。

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// DB とアップロードされたファイルを置くディレクトリ（`DISNANS_DATA_DIR`）。
    pub data_dir: PathBuf,
    /// 待ち受けるアドレス（`DISNANS_BIND`）。本番では Tailscale の IP を指定する。
    pub bind: SocketAddr,
    /// 開発モード（`DISNANS_DEV=1`）。whois を使わず、ヘッダーかクエリでユーザーを指定する。
    pub dev: bool,
    /// tailscaled の LocalAPI のソケット（`DISNANS_TAILSCALE_SOCKET`）。
    pub tailscale_socket: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());

        let bind = var("DISNANS_BIND").unwrap_or_else(|| "127.0.0.1:8080".into());
        let bind = bind
            .parse()
            .map_err(|e| format!("DISNANS_BIND が不正です（{bind}）: {e}"))?;

        Ok(Self {
            data_dir: var("DISNANS_DATA_DIR")
                .unwrap_or_else(|| "./data".into())
                .into(),
            bind,
            dev: var("DISNANS_DEV").is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true")),
            tailscale_socket: var("DISNANS_TAILSCALE_SOCKET")
                .unwrap_or_else(|| "/var/run/tailscale/tailscaled.sock".into())
                .into(),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("disnans.db")
    }

    /// 保存済みのファイル（本体とサムネイル）。
    pub fn files_dir(&self) -> PathBuf {
        self.data_dir.join("files")
    }

    /// アップロード中の一時ファイル。
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }
}
