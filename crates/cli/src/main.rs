mod args;
mod output;

use std::io::{self, Write};
use std::process::ExitCode;

use args::{Cli, Command, ConfigAction};
use clap::Parser;
use disnans_client_core::{
    ClientError, LocalStore, MessagesQuery, RestClient, ServerUrl, StoreError, UrlError,
};

#[derive(Debug)]
enum CliError {
    Usage(String),
    Store(StoreError),
    Url(UrlError),
    Client(ClientError),
    Json(serde_json::Error),
    Io(io::Error),
}

impl CliError {
    fn exit_code(&self) -> u8 {
        match self {
            Self::Usage(_) | Self::Url(_) | Self::Client(ClientError::InvalidDevUser) => 2,
            Self::Client(ClientError::Request(e)) if e.is_connect() || e.is_timeout() => 3,
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
                    thread_id: None,
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
