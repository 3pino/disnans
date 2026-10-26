use std::net::SocketAddr;
use std::time::Duration;

use disnans_server::config::Config;
use disnans_server::update::RESTART_EXIT_CODE;
use tracing_subscriber::EnvFilter;

/// 再起動の要求のあと、接続が閉じきらないときに待つ上限。
const RESTART_GRACE: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if matches!(std::env::args().nth(1).as_deref(), Some("--version" | "-V")) {
        println!("disnans-server {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,disnans_server=debug")),
        )
        .init();

    let config = Config::from_env()?;
    if config.dev {
        tracing::warn!(
            "開発モードです。whois を使わず、X-Dev-User / ?dev_user= でユーザーを決めます"
        );
    }
    tracing::info!(data_dir = %config.data_dir.display(), "データディレクトリ");

    let bind = config.bind;
    let (app, state) = disnans_server::build(config).await?;
    // 自動更新は設定で有効にしたときだけ（既定は無効）。取得先は本番の固定値
    let auto_update = std::env::var("DISNANS_AUTO_UPDATE").is_ok_and(|v| v == "1");
    tracing::info!(
        版 = env!("CARGO_PKG_VERSION"),
        待受 = %bind,
        自動更新 = if auto_update { "有効" } else { "無効" },
        "起動しました"
    );
    if auto_update {
        disnans_server::update::spawn_update_task(
            state.clone(),
            disnans_server::update::RELEASE_API_URL.into(),
        );
    }

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("{bind} で待ち受けます");
    // Tailscale Serve 経由の接続（接続元はループバック）用。ループバックのアドレスだけ許す
    if let Some(local) = local_bind()? {
        let listener = tokio::net::TcpListener::bind(local).await?;
        tracing::info!("{local} で待ち受けます（Tailscale Serve 用。ループバックだけ）");
        let app = app.clone();
        tokio::spawn(async move {
            let served = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
            if let Err(e) = served {
                tracing::error!("ループバックの待ち受けが止まりました: {e}");
            }
        });
    }
    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state.clone()));
    // 自動更新で入れ替えたあとは、接続が閉じきらなくても一定の時間で終える
    let forced = async {
        state.restart.wait().await;
        tokio::time::sleep(RESTART_GRACE).await;
    };
    tokio::select! {
        result = serve => result?,
        _ = forced => tracing::warn!("接続が閉じきらないので、そのまま終了します"),
    }

    if state.restart.requested() {
        tracing::info!("再起動のため終了コード {RESTART_EXIT_CODE} で終わります");
        std::process::exit(RESTART_EXIT_CODE);
    }
    Ok(())
}

/// `DISNANS_LOCAL_BIND`（任意）。ループバックのアドレスでなければ起動時に失敗する。
fn local_bind() -> Result<Option<SocketAddr>, String> {
    let Some(v) = std::env::var("DISNANS_LOCAL_BIND")
        .ok()
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    let addr: SocketAddr = v
        .parse()
        .map_err(|e| format!("DISNANS_LOCAL_BIND が不正です（{v}）: {e}"))?;
    if !addr.ip().is_loopback() {
        return Err(format!(
            "DISNANS_LOCAL_BIND はループバックのアドレスにしてください（{v}）"
        ));
    }
    Ok(Some(addr))
}

/// Ctrl+C か SIGTERM、または自動更新の再起動の要求で終了する。
async fn shutdown_signal(state: disnans_server::state::SharedState) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
        _ = state.restart.wait() => {},
    }
    tracing::info!("終了します");
}
