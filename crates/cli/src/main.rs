mod args;
mod live;
mod output;
mod send;
mod timefmt;
mod tui;
mod update;
mod watch;

use std::io::{self, Write};
use std::process::ExitCode;

use args::{Cli, Command, ConfigAction};
use clap::Parser;
use disnans_client_core::{
    ClientError, LocalStore, MessagesQuery, RestClient, ServerUrl, StoreError, UrlError, WsError,
};

#[derive(Debug)]
enum CliError {
    Usage(String),
    Store(StoreError),
    Url(UrlError),
    Client(ClientError),
    Ws(WsError),
    Body(send::BodyError),
    /// サーバーが確実に未保存と示した拒否（終了コード1）。
    SendRejected {
        client_id: String,
        code: String,
        message: String,
    },
    /// 何も書き込む前に送信を断念した（終了コード1）。
    SendNotSent(String),
    /// 送信を試みた後で成否が分からない（終了コード4）。自動再送はしない。
    SendUnknown {
        client_id: Option<String>,
        detail: String,
    },
    /// 再接続が認証拒否などで終端になった（終了コード1）。
    WatchFailed {
        reason: String,
        http_status: Option<u16>,
    },
    /// サーバーがリアクションを拒否した（終了コード1）。
    ReactRejected {
        code: String,
        message: String,
    },
    /// リアクションの結果が不明（終了コード4）。自動再送はしない。
    ReactUnknown(String),
    /// Ctrl-C。送信前または watch の正常中断（終了コード130）。
    Interrupted,
    Json(serde_json::Error),
    Io(io::Error),
}

impl CliError {
    fn exit_code(&self) -> u8 {
        match self {
            Self::Usage(_) | Self::Url(_) | Self::Client(ClientError::InvalidDevUser) => 2,
            Self::Client(ClientError::Request(e)) if e.is_connect() || e.is_timeout() => 3,
            Self::Ws(WsError::InvalidUrl(_) | WsError::InvalidDevUser) => 2,
            Self::Ws(WsError::Connect(_) | WsError::Timeout) => 3,
            Self::Body(send::BodyError::Io(_)) => 1,
            Self::Body(_) => 2,
            Self::SendUnknown { .. } | Self::ReactUnknown(_) => 4,
            Self::Interrupted => 130,
            _ => 1,
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(e) => f.write_str(e),
            Self::Store(e) => write!(f, "{e}"),
            Self::Url(e) => write!(f, "{e}"),
            Self::Client(e) => write!(f, "{e}"),
            Self::Ws(e) => write!(f, "{e}"),
            Self::Body(e) => write!(f, "{e}"),
            Self::SendRejected {
                client_id,
                code,
                message,
            } => write!(
                f,
                "サーバーが投稿を受け付けませんでした ({code}): {message} [client_id: {client_id}]"
            ),
            Self::SendNotSent(reason) => write!(f, "送信していません: {reason}"),
            Self::ReactRejected { code, message } => {
                write!(
                    f,
                    "サーバーがリアクションを受け付けませんでした ({code}): {message}"
                )
            }
            Self::ReactUnknown(detail) => write!(
                f,
                "リアクションの結果が不明です。再送していません。`disnans messages --json` で確認してください ({detail})"
            ),
            Self::SendUnknown { client_id, detail } => {
                f.write_str(
                    "送信結果が不明です。二重投稿を避けるため再送していません。`disnans messages` で確認してください",
                )?;
                if let Some(id) = client_id {
                    write!(f, " [client_id: {id}]")?;
                }
                write!(f, " ({detail})")
            }
            Self::WatchFailed {
                reason,
                http_status,
            } => {
                write!(f, "監視を続けられません: {reason}")?;
                if let Some(status) = http_status {
                    write!(f, " (HTTP {status})")?;
                }
                Ok(())
            }
            Self::Interrupted => f.write_str("中断しました"),
            Self::Json(e) => write!(f, "JSONを生成できませんでした: {e}"),
            Self::Io(e) => write!(f, "標準出力に書けませんでした: {e}"),
        }
    }
}

impl From<StoreError> for CliError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}
impl From<UrlError> for CliError {
    fn from(value: UrlError) -> Self {
        Self::Url(value)
    }
}
impl From<ClientError> for CliError {
    fn from(value: ClientError) -> Self {
        Self::Client(value)
    }
}
impl From<WsError> for CliError {
    fn from(value: WsError) -> Self {
        Self::Ws(value)
    }
}
impl From<send::BodyError> for CliError {
    fn from(value: send::BodyError) -> Self {
        Self::Body(value)
    }
}
impl From<serde_json::Error> for CliError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

fn resolve_server(
    override_url: Option<&str>,
    read_saved: impl FnOnce() -> Result<Option<String>, CliError>,
) -> Result<ServerUrl, CliError> {
    // --server は共有設定ファイルを開かず、読み込みも書き込みもしない。
    if let Some(input) = override_url {
        return Ok(ServerUrl::parse(input)?);
    }
    let saved = read_saved()?;
    let input = saved
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CliError::Usage("接続先が未設定です: disnans config set-server <URL>".into())
        })?;
    Ok(ServerUrl::parse(input)?)
}

fn saved_server() -> Result<Option<String>, CliError> {
    Ok(LocalStore::open_default()?.server_url()?)
}

async fn run(cli: Cli) -> Result<String, CliError> {
    match cli.command {
        Command::Config {
            action: ConfigAction::SetServer { url },
        } => {
            let url = ServerUrl::parse(&url)?;
            LocalStore::open_default()?.set_server_url(Some(url.as_str()))?;
            Ok(format!("接続先: {}", output::escape_human(url.as_str())))
        }
        Command::Config {
            action: ConfigAction::Show(opts),
        } => {
            let saved = saved_server()?;
            if opts.json {
                Ok(output::json_value(
                    &serde_json::json!({ "server_url": saved }),
                )?)
            } else {
                Ok(saved
                    .as_deref()
                    .map_or_else(|| "未設定".to_owned(), output::escape_human))
            }
        }
        Command::Me(opts) => {
            let server = resolve_server(cli.server.as_deref(), saved_server)?;
            let me = RestClient::new(server, cli.dev_user.as_deref())?
                .me()
                .await?;
            if opts.json {
                Ok(output::json_value(&me)?)
            } else {
                Ok(output::human_user(&me))
            }
        }
        Command::Messages(opts) => {
            let server = resolve_server(cli.server.as_deref(), saved_server)?;
            let client = RestClient::new(server, cli.dev_user.as_deref())?;
            let messages = client
                .messages(&MessagesQuery {
                    before: opts.before,
                    limit: Some(opts.limit),
                })
                .await?;
            if opts.json {
                Ok(output::json_value(&messages)?)
            } else {
                let users = client.users().await?;
                Ok(output::human_messages(&messages, &users))
            }
        }
        Command::Send(args) => {
            let body = live::read_send_body(&args)?;
            let server = resolve_server(cli.server.as_deref(), saved_server)?;
            live::send(
                server,
                cli.dev_user,
                body,
                args.silent,
                args.reply_to,
                args.json,
            )
            .await
        }
        Command::React(args) => {
            let server = resolve_server(cli.server.as_deref(), saved_server)?;
            live::react(server, cli.dev_user, args, true).await
        }
        Command::Unreact(args) => {
            let server = resolve_server(cli.server.as_deref(), saved_server)?;
            live::react(server, cli.dev_user, args, false).await
        }
        Command::Update(args) => update::run(args).await,
        // `watch` と `tui` は出力を逐次書くため `main` が直接扱う。
        Command::Watch(_) | Command::Tui => Err(CliError::Usage("直接実行するコマンドです".into())),
    }
}

fn report(
    result: Result<String, CliError>,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> u8 {
    match result {
        Ok(text) => match writeln!(stdout, "{text}") {
            Ok(()) => 0,
            // `head` 等へのパイプが閉じた場合は通常の終了とする。
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => 0,
            Err(e) => report_error(CliError::Io(e), stderr),
        },
        Err(e) => report_error(e, stderr),
    }
}

fn report_error(e: CliError, stderr: &mut impl Write) -> u8 {
    let _ = writeln!(stderr, "エラー: {}", output::escape_human(&e.to_string()));
    e.exit_code()
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Command::Watch(opts) = &cli.command {
        let result = match resolve_server(cli.server.as_deref(), saved_server) {
            Ok(server) => live::watch(server, cli.dev_user.clone(), opts.json).await,
            Err(e) => Err(e),
        };
        return ExitCode::from(match result {
            Ok(()) => 0,
            Err(e) => report_error(e, &mut io::stderr().lock()),
        });
    }
    if matches!(cli.command, Command::Tui) {
        let result = match resolve_server(cli.server.as_deref(), saved_server) {
            Ok(server) => tui::run(server, cli.dev_user.clone()).await,
            Err(e) => Err(e),
        };
        return ExitCode::from(match result {
            Ok(()) => 0,
            Err(e) => report_error(e, &mut io::stderr().lock()),
        });
    }
    let result = run(cli).await;
    ExitCode::from(report(
        result,
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_usage_and_connection_failures_to_documented_exit_codes() {
        assert_eq!(CliError::Usage("未設定".into()).exit_code(), 2);
        assert_eq!(
            CliError::Url(ServerUrl::parse("").unwrap_err()).exit_code(),
            2
        );
        assert_eq!(CliError::Client(ClientError::InvalidDevUser).exit_code(), 2);
    }

    #[test]
    fn success_and_errors_never_mix_stdout_and_stderr() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(
            report(Ok("{\"messages\":[]}".into()), &mut out, &mut err),
            0
        );
        assert_eq!(String::from_utf8(out).unwrap(), "{\"messages\":[]}\n");
        assert!(err.is_empty());

        let (mut out, mut err) = (Vec::new(), Vec::new());
        let failure = CliError::Usage("接続先なし\u{1b}[2J".into());
        assert_eq!(report(Err(failure), &mut out, &mut err), 2);
        assert!(out.is_empty());
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "エラー: 接続先なし\\u{1B}[2J\n"
        );
    }

    #[test]
    fn missing_saved_server_fails_instead_of_using_localhost() {
        let temp = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(temp.path()).unwrap();
        assert!(matches!(
            resolve_server(None, || Ok(store.server_url()?)),
            Err(CliError::Usage(_))
        ));
        assert_eq!(
            resolve_server(Some("100.64.0.1:8080"), || {
                panic!("--server must not access shared storage")
            })
            .unwrap()
            .as_str(),
            "http://100.64.0.1:8080"
        );
        assert!(store.server_url().unwrap().is_none());
    }
}
