//! `send` / `watch` の通信。送信は一度だけ試み、結果が不明でも自動再送しない。

use std::io::{self, IsTerminal, Write};
use std::time::Duration;

use disnans_client_core::{
    ChatConnection, ChatWatch, ConnectOptions, SendOutcome, ServerUrl, UnknownReason, WatchItem,
    new_client_id,
};
use tokio::signal::ctrl_c;

use crate::args::SendArgs;
use crate::{CliError, output, send, watch};

/// 投稿の確認応答を待つ上限。
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
/// 試験用に確認待ちを短くする隠し環境変数（ミリ秒）。利用者向けの設定ではない。
const ACK_TIMEOUT_ENV: &str = "DISNANS_CLI_ACK_TIMEOUT_MS";

pub(crate) fn ack_timeout() -> Result<Duration, CliError> {
    ack_timeout_from(std::env::var(ACK_TIMEOUT_ENV).ok().as_deref())
}

/// 未設定は既定値。不正値（0・範囲外・非数）は黙って既定値にせず使い方の誤りとする。
fn ack_timeout_from(value: Option<&str>) -> Result<Duration, CliError> {
    let Some(value) = value else {
        return Ok(ACK_TIMEOUT);
    };
    match value.parse::<u64>() {
        Ok(ms) if (1..=60_000).contains(&ms) => Ok(Duration::from_millis(ms)),
        _ => Err(CliError::Usage(format!(
            "{ACK_TIMEOUT_ENV} は 1〜60000 の整数（ミリ秒）で指定してください"
        ))),
    }
}

pub fn read_send_body(args: &SendArgs) -> Result<String, CliError> {
    let body = if args.stdin {
        let stdin = io::stdin();
        let is_terminal = stdin.is_terminal();
        send::read_stdin_body(stdin.lock(), is_terminal)?
    } else {
        send::validate_body(args.text.clone().unwrap_or_default())?
    };
    Ok(body)
}

fn options(dev_user: Option<String>) -> ConnectOptions {
    ConnectOptions {
        dev_user,
        ..ConnectOptions::default()
    }
}

pub async fn send(
    server: ServerUrl,
    dev_user: Option<String>,
    body: String,
    silent: bool,
    json: bool,
) -> Result<String, CliError> {
    let ack_timeout = ack_timeout()?;
    let mut interrupt = std::pin::pin!(ctrl_c());
    // 接続中はまだ何も書き込んでいないので、Ctrl-C は 130。
    let mut connection = tokio::select! {
        result = ChatConnection::connect(&server, options(dev_user)) => result?,
        _ = &mut interrupt => return Err(CliError::Interrupted),
    };
    // 書き込みが始まったか分からないため、これ以降の中断は成否不明として扱う。
    // 中断しても確認に使えるよう、client_id は先に決めて表示する。
    let client_id = new_client_id();
    let outcome = tokio::select! {
        outcome = connection.send_message_with_id(&client_id, &body, silent, ack_timeout) => outcome,
        _ = &mut interrupt => {
            return Err(CliError::SendUnknown {
                client_id: Some(client_id),
                detail: "確認応答を待つ間に中断されました".into(),
            });
        }
    };
    connection.close().await;
    send_result(outcome, json)
}

pub fn send_result(outcome: SendOutcome, json: bool) -> Result<String, CliError> {
    match outcome {
        SendOutcome::Confirmed { client_id, message } => {
            if json {
                Ok(output::json_value(&serde_json::json!({
                    "message_id": message.id,
                    "client_id": client_id,
                }))?)
            } else {
                Ok(output::escape_human(&message.id))
            }
        }
        SendOutcome::Rejected {
            client_id,
            code,
            message,
        } => Err(CliError::SendRejected {
            client_id,
            code,
            message,
        }),
        SendOutcome::NotSent { reason } => Err(CliError::SendNotSent(reason)),
        SendOutcome::Unknown { client_id, reason } => Err(CliError::SendUnknown {
            client_id: Some(client_id),
            detail: unknown_reason(&reason),
        }),
    }
}

pub(crate) fn unknown_reason(reason: &UnknownReason) -> String {
    match reason {
        UnknownReason::Disconnected => "確認前に接続が切れました".into(),
        UnknownReason::Timeout => "確認応答がタイムアウトしました".into(),
        UnknownReason::WriteFailed => "送信データの書き込みに失敗しました".into(),
        UnknownReason::ServerError { code, message } => {
            format!("サーバーのエラー {code}: {message}")
        }
    }
}

pub async fn watch(
    server: ServerUrl,
    dev_user: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let mut interrupt = std::pin::pin!(ctrl_c());
    let mut stream = tokio::select! {
        result = ChatWatch::start(&server, options(dev_user)) => result?,
        _ = &mut interrupt => return Err(CliError::Interrupted),
    };
    let mut stdout = io::stdout().lock();
    let result = loop {
        let item = tokio::select! {
            item = stream.next() => item,
            _ = &mut interrupt => break Err(CliError::Interrupted),
        };
        let (line, to_stderr) = match item {
            WatchItem::Failed {
                reason,
                http_status,
            } => {
                break Err(CliError::WatchFailed {
                    reason,
                    http_status,
                });
            }
            WatchItem::Connected { generation, .. } => {
                (Some(watch::connected_line(generation, json)), !json)
            }
            WatchItem::Gap { generation, reason } => {
                (Some(watch::gap_line(generation, &reason, json)), !json)
            }
            WatchItem::Event { generation, event } => {
                (watch::event_line(generation, &event, json), false)
            }
            // Reconnect attempts are not printed; ChatWatch does not return them anyway.
            WatchItem::Connecting { .. } => (None, false),
        };
        let Some(line) = line else { continue };
        let written = if to_stderr {
            writeln!(io::stderr().lock(), "{line}")
        } else {
            writeln!(stdout, "{line}").and_then(|()| stdout.flush())
        };
        match written {
            Ok(()) => {}
            // `head` 等へのパイプが閉じたら正常終了する。
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => break Ok(()),
            Err(e) => break Err(CliError::Io(e)),
        }
    };
    stream.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::send::BodyError;
    use disnans_client_core::{Message, WsError};

    fn message(id: &str) -> Message {
        Message {
            id: id.into(),
            author_id: "u".into(),
            thread_id: None,
            reply_to: None,
            reply_preview: None,
            body: "x".into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1,
            edited_at: None,
            thread: None,
            card: None,
            bot: None,
        }
    }

    #[test]
    fn hidden_ack_timeout_override_is_bounded_and_invalid_values_are_usage_errors() {
        assert_eq!(ack_timeout_from(None).unwrap(), ACK_TIMEOUT);
        assert_eq!(
            ack_timeout_from(Some("300")).unwrap(),
            Duration::from_millis(300)
        );
        for invalid in ["0", "60001", "-1", "x", ""] {
            assert_eq!(ack_timeout_from(Some(invalid)).unwrap_err().exit_code(), 2);
        }
    }

    #[test]
    fn confirmed_prints_only_the_message_id_or_ids_as_json() {
        let outcome = || SendOutcome::Confirmed {
            client_id: "c1".into(),
            message: message("m1"),
        };
        assert_eq!(send_result(outcome(), false).unwrap(), "m1");
        assert_eq!(
            send_result(outcome(), true).unwrap(),
            r#"{"client_id":"c1","message_id":"m1"}"#
        );
    }

    #[test]
    fn send_outcomes_map_to_documented_exit_codes_without_resending() {
        let rejected = send_result(
            SendOutcome::Rejected {
                client_id: "c".into(),
                code: "empty_message".into(),
                message: "空".into(),
            },
            false,
        )
        .unwrap_err();
        assert_eq!(rejected.exit_code(), 1);

        let not_sent = send_result(SendOutcome::NotSent { reason: "x".into() }, false).unwrap_err();
        assert_eq!(not_sent.exit_code(), 1);

        for reason in [
            UnknownReason::Disconnected,
            UnknownReason::Timeout,
            UnknownReason::WriteFailed,
            UnknownReason::ServerError {
                code: "internal".into(),
                message: "m".into(),
            },
        ] {
            let error = send_result(
                SendOutcome::Unknown {
                    client_id: "01CLIENT".into(),
                    reason,
                },
                true,
            )
            .unwrap_err();
            assert_eq!(error.exit_code(), 4);
            let text = error.to_string();
            assert!(text.contains("二重投稿を避けるため再送していません"));
            assert!(text.contains("`disnans messages`"));
            assert!(text.contains("01CLIENT"));
        }
    }

    #[test]
    fn connection_and_input_errors_have_distinct_exit_codes() {
        for (error, code) in [
            (CliError::Ws(WsError::Connect("refused".into())), 3),
            (CliError::Ws(WsError::Timeout), 3),
            (CliError::Ws(WsError::Http { status: 401 }), 1),
            (CliError::Ws(WsError::Http { status: 403 }), 1),
            (CliError::Ws(WsError::Protocol("closed".into())), 1),
            (CliError::Ws(WsError::InvalidUrl("x".into())), 2),
            (CliError::Ws(WsError::InvalidDevUser), 2),
            (CliError::Body(BodyError::Empty), 2),
            (CliError::Body(BodyError::TerminalStdin), 2),
            (CliError::Body(BodyError::Io("x".into())), 1),
            (CliError::Interrupted, 130),
            (
                CliError::WatchFailed {
                    reason: "拒否".into(),
                    http_status: Some(401),
                },
                1,
            ),
        ] {
            assert_eq!(error.exit_code(), code, "{error}");
        }
    }

    #[test]
    fn errors_never_echo_the_message_body() {
        let secret = "秘密の本文";
        let mut body_error = send::validate_body(secret.repeat(5000))
            .unwrap_err()
            .to_string();
        body_error.push_str(&CliError::SendNotSent("接続が切れています".into()).to_string());
        assert!(!body_error.contains(secret));
    }
}
