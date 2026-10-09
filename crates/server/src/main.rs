use std::net::SocketAddr;

use disnans_server::config::Config;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    let (app, _state) = disnans_server::build(config).await?;

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("{bind} で待ち受けます");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Ctrl+C か SIGTERM で終了する。
async fn shutdown_signal() {
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
    }
    tracing::info!("終了します");
}
