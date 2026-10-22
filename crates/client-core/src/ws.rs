//! WebSocket chat client (crate feature `ws`).
//!
//! * [`ChatConnection`] is one connection for sending messages and reading events. Sends are
//!   confirmed by `client_id` and are never retried automatically.
//! * [`ChatWatch`] is a long-lived subscription that reconnects with backoff.
//! * [`ChatSession`] is the same reconnecting subscription, plus sending through [`SessionSender`]
//!   over the same connection. Use it when one client both reads and sends.
//!
//! # Gap and refetch contract (for [`ChatWatch`])
//!
//! Events are not replayed after a reconnect. Instead:
//! - A disconnect yields `Gap { reason }`. Events from that moment until the next
//!   `Connected { generation >= 2 }` may be lost. Do not trust the stream for that window.
//! - After `Connected { generation >= 2 }`, refetch the history over REST. The new subscription is
//!   live from that point, and message IDs remove overlaps between REST and WebSocket.
//! - `Gap { reason: "lagged" }` means the local queue overflowed. Refetch as well. A refetch made
//!   during a disconnect window is completed by the next `Connected { generation >= 2 }`.
//!
//! Do not use one `ChatConnection` for [`ChatConnection::send_message`] and a [`ChatWatch`] at
//! the same time: `send_message` discards events that are not its own acknowledgement.

use std::{
    collections::{HashMap, VecDeque},
    fmt,
    future::Future,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use disnans_shared::ClientEvent;
/// Shared wire types, re-exported so callers do not need a direct `disnans-shared` dependency.
pub use disnans_shared::{Message, ServerEvent, User};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::TcpStream,
    sync::{Notify, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant as TokioInstant, sleep, sleep_until, timeout, timeout_at},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        self, Message as WsMessage, client::IntoClientRequest, handshake::client::Request,
        http::HeaderValue, protocol::WebSocketConfig,
    },
};
use url::Url;

use crate::ServerUrl;

/// Longest message body the server accepts (characters).
const MAX_BODY_CHARS: usize = 10_000;
/// Largest WebSocket message and frame this client accepts. Server events are far smaller.
const MAX_MESSAGE_BYTES: usize = 8 << 20;
/// Header carrying the development identity; the server reads it before the query string.
const DEV_USER_HEADER: &str = "X-Dev-User";
/// Server error codes that are returned before the message is committed. Any other error after a
/// send is reported as [`UnknownReason::ServerError`] because the outcome is not known.
const REJECTED_CODES: [&str; 6] = [
    "empty_message",
    "body_too_long",
    "reply_not_found",
    "reply_other_place",
    "invalid_attachment",
    "invalid_link",
];
/// `reason` of the gap emitted when the queue overflows.
const LAGGED: &str = "lagged";
/// Queue depth for commands waiting for the session task.
const COMMAND_QUEUE: usize = 64;
/// Upper bound on a single frame write. A write that takes longer means the socket is stuck.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const NOT_CONNECTED: &str = "接続していないため送信しませんでした";
const IDLE_REASON: &str = "無通信が続いたため送信しませんでした。接続し直してください";
const DUPLICATE_ID: &str = "同じ client_id の送信が確認待ちのため送信しませんでした";
const SESSION_ENDED: &str = "セッションが終了しているため送信しませんでした";
/// A connection that lived at least this long resets the backoff.
const STABLE_CONNECTION: Duration = Duration::from_secs(30);

/// Options for opening a WebSocket connection.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Development identity, sent in the `X-Dev-User` header. Must be visible ASCII.
    pub dev_user: Option<String>,
    /// Time limit for TCP/TLS and the HTTP upgrade. Default: 10 seconds.
    pub connect_timeout: Duration,
    /// Time limit for the first `hello` event after the upgrade. Default: 10 seconds.
    pub hello_timeout: Duration,
    /// Longest time without any frame from the server while waiting for events. Also the limit
    /// after which a connection that has not sent anything (no reads, so no pong) is treated as
    /// dead. Default: 90 seconds, matching the server's idle timeout.
    pub idle_timeout: Duration,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            dev_user: None,
            connect_timeout: Duration::from_secs(10),
            hello_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(90),
        }
    }
}

/// Failure to establish a connection. Connection attempts are never retried by this error path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsError {
    InvalidUrl(String),
    /// DNS, TCP, or TLS failure.
    Connect(String),
    /// The server rejected the upgrade request (for example 401 or 403).
    Http {
        status: u16,
    },
    /// Connecting or waiting for `hello` took longer than allowed.
    Timeout,
    /// The connection closed or misbehaved before `hello`.
    Protocol(String),
    /// The development identity is empty, contains a line break, or is not visible ASCII.
    InvalidDevUser,
}

impl fmt::Display for WsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(e) => write!(f, "サーバーURLが不正です: {e}"),
            Self::Connect(e) => write!(f, "サーバーに接続できません: {e}"),
            Self::Http { status } => write!(f, "WebSocket の接続が拒否されました（HTTP {status}）"),
            Self::Timeout => write!(f, "接続または応答がタイムアウトしました"),
            Self::Protocol(e) => write!(f, "WebSocket の応答が不正です: {e}"),
            Self::InvalidDevUser => write!(f, "開発用ユーザーIDが不正です"),
        }
    }
}

impl std::error::Error for WsError {}

/// The connection ended. The caller decides whether to reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disconnected {
    pub reason: String,
}

impl fmt::Display for Disconnected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "接続が切れました: {}", self.reason)
    }
}

impl std::error::Error for Disconnected {}

/// Result of [`ChatConnection::send_message`].
// The payloads are the wire types themselves, so the size gap is accepted rather than boxed.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum SendOutcome {
    /// The server committed the message and sent it back to this connection.
    Confirmed { client_id: String, message: Message },
    /// The server refused the message with a code that guarantees it was not committed.
    Rejected {
        client_id: String,
        code: String,
        message: String,
    },
    /// The outcome is unknown: the message may or may not have been committed. Do not resend it
    /// automatically; show the user the outcome and let them decide.
    Unknown {
        client_id: String,
        reason: UnknownReason,
    },
    /// Refused before anything was written (empty, too long, or the connection is unusable).
    NotSent { reason: String },
}

/// Result of [`ChatConnection::react`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReactOutcome {
    /// The server broadcast the reaction state we asked for.
    Confirmed,
    /// The server answered with an error (e.g. the message does not exist, invalid emoji).
    Rejected { code: String, message: String },
    /// Reactions are idempotent, but the result is not known (no update within the timeout, or
    /// the connection ended). Not retried automatically.
    Unknown(UnknownReason),
    /// Refused before anything was written.
    NotSent { reason: String },
}

/// Why the outcome of a send is unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnknownReason {
    /// The connection ended before the acknowledgement arrived.
    Disconnected,
    /// No acknowledgement arrived within the timeout.
    Timeout,
    /// Writing the frame failed. The frame may have been partially written.
    WriteFailed,
    /// The server sent an error that does not prove the message was refused.
    ServerError { code: String, message: String },
}

/// Generate a new random client ID for [`ChatConnection::send_message_with_id`]. Print it before
/// sending if the caller may be interrupted, so the outcome can be found later.
pub fn new_client_id() -> String {
    ulid::Ulid::new().to_string()
}

/// One WebSocket connection to the chat server.
pub struct ChatConnection {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    me: User,
    users: Vec<User>,
    idle_timeout: Duration,
    /// Last time this side wrote a frame (messages or pongs). The server closes a connection that
    /// has been silent from the client side for its idle timeout, so sends are refused past that.
    last_sent: TokioInstant,
    /// `false` after a write may have partially reached the socket, or after the connection
    /// ended. Further sends are refused; reads may still return buffered events.
    sendable: bool,
}

impl ChatConnection {
    /// Connect, then wait for `hello`. Events received before `hello` are ignored.
    pub async fn connect(server: &ServerUrl, opts: ConnectOptions) -> Result<Self, WsError> {
        let url = websocket_url(server)?;
        let request = build_request(&url, opts.dev_user.as_deref())?;
        let mut socket = match timeout(
            opts.connect_timeout,
            connect_async_with_config(request, Some(client_config()), false),
        )
        .await
        {
            Err(_) => return Err(WsError::Timeout),
            Ok(Ok((socket, _response))) => socket,
            Ok(Err(err)) => return Err(map_connect_error(err)),
        };
        let (me, users) = match timeout(opts.hello_timeout, wait_for_hello(&mut socket)).await {
            Err(_) => return Err(WsError::Timeout),
            Ok(result) => result?,
        };
        Ok(Self {
            socket,
            me,
            users,
            idle_timeout: opts.idle_timeout,
            last_sent: TokioInstant::now(),
            sendable: true,
        })
    }

    /// The signed-in user, from `hello`.
    pub fn me(&self) -> &User {
        &self.me
    }

    /// All users, from `hello`.
    pub fn users(&self) -> &[User] {
        &self.users
    }

    /// Send one message to the main chat (no attachments, no reply), with a new
    /// client ID. See [`ChatConnection::send_message_with_id`].
    pub async fn send_message(
        &mut self,
        body: &str,
        silent: bool,
        ack_timeout: Duration,
    ) -> SendOutcome {
        self.send_message_with_id(&new_client_id(), body, silent, ack_timeout)
            .await
    }

    /// Send one message to the main chat using the caller's `client_id`.
    ///
    /// The result is settled only by a `message.created` or `error` carrying this `client_id` on
    /// this connection. Other events received while waiting are discarded, and errors for other
    /// client IDs are ignored, so do not run this on a connection that is also used for
    /// [`ChatWatch`] or event reading. The message is never retried automatically. `client_id`
    /// must be unique per logical message.
    pub async fn send_message_with_id(
        &mut self,
        client_id: &str,
        body: &str,
        silent: bool,
        ack_timeout: Duration,
    ) -> SendOutcome {
        let request = SendRequest {
            body: body.to_owned(),
            silent,
            ..SendRequest::default()
        };
        self.send_request_with_id(client_id, request, ack_timeout)
            .await
    }

    /// Like [`ChatConnection::send_message_with_id`] with all `message.send` options (reply
    /// target, attachments, silent). Same outcome rules; never retried automatically.
    pub async fn send_request_with_id(
        &mut self,
        client_id: &str,
        request: SendRequest,
        ack_timeout: Duration,
    ) -> SendOutcome {
        let request = &request;
        if let Err(reason) = validate_send(client_id, request) {
            return SendOutcome::NotSent { reason };
        }
        if !self.sendable {
            return SendOutcome::NotSent {
                reason: "接続が切れているため送信できません".into(),
            };
        }
        if self.last_sent.elapsed() >= self.idle_timeout {
            // Not read for too long, so the server has likely dropped the connection. Nothing has
            // been written, so refusing is safe.
            return SendOutcome::NotSent {
                reason: "無通信が続いたため送信しませんでした。接続し直してください".into(),
            };
        }

        let client_id = client_id.to_owned();
        let text = match send_frame(&client_id, request) {
            Ok(text) => text,
            Err(err) => {
                return SendOutcome::NotSent {
                    reason: format!("送信データを作れません: {err}"),
                };
            }
        };

        let deadline = TokioInstant::now() + ack_timeout;
        // Write phase. A timeout or error here can leave a partial frame in the socket buffer,
        // so the connection must not send anything else.
        match timeout_at(deadline, self.socket.send(WsMessage::Text(text.into()))).await {
            Err(_) => {
                self.sendable = false;
                return unknown(client_id, UnknownReason::Timeout);
            }
            Ok(Err(_)) => {
                self.sendable = false;
                return unknown(client_id, UnknownReason::WriteFailed);
            }
            Ok(Ok(())) => self.last_sent = TokioInstant::now(),
        }

        // Acknowledgement phase. The frame is fully written, so a timeout here does not poison
        // the connection.
        loop {
            let next = match timeout_at(deadline, self.socket.next()).await {
                Err(_) => return unknown(client_id, UnknownReason::Timeout),
                Ok(next) => next,
            };
            match next {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => {
                    self.sendable = false;
                    return unknown(client_id, UnknownReason::Disconnected);
                }
                Some(Ok(WsMessage::Text(text))) => {
                    let Ok(event) = serde_json::from_str::<ServerEvent>(text.as_str()) else {
                        continue;
                    };
                    match event {
                        ServerEvent::MessageCreated {
                            client_id: Some(id),
                            message,
                        } if id == client_id => {
                            return SendOutcome::Confirmed { client_id, message };
                        }
                        // An error for another send on this connection says nothing about this one.
                        ServerEvent::Error {
                            client_id: Some(id),
                            ..
                        } if id != client_id => {}
                        ServerEvent::Error {
                            client_id: Some(id),
                            code,
                            message,
                        } if id == client_id && REJECTED_CODES.contains(&code.as_str()) => {
                            return SendOutcome::Rejected {
                                client_id,
                                code,
                                message,
                            };
                        }
                        // Our own error with another code, or an error without a client_id: the
                        // outcome is not known.
                        ServerEvent::Error { code, message, .. } => {
                            return unknown(
                                client_id,
                                UnknownReason::ServerError { code, message },
                            );
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Ping(_))) => {
                    // tungstenite queues the pong and writes it on flush.
                    match timeout_at(deadline, self.socket.flush()).await {
                        Err(_) => return unknown(client_id, UnknownReason::Timeout),
                        Ok(Err(_)) => {
                            self.sendable = false;
                            return unknown(client_id, UnknownReason::Disconnected);
                        }
                        Ok(Ok(())) => self.last_sent = TokioInstant::now(),
                    }
                }
                Some(Ok(_)) => {}
            }
        }
    }

    /// Add (`add`) or remove the caller's reaction `emoji` on `message_id`.
    ///
    /// `reaction.add` / `reaction.remove` carry no `client_id`, so the result is settled by the
    /// next `reaction.updated` for this message that shows the wanted state (the caller's user ID
    /// present or absent under `emoji`), or by an `error` event. Do not run this on a connection
    /// that is also used for other sends. Never retried automatically.
    pub async fn react(
        &mut self,
        message_id: &str,
        emoji: &str,
        add: bool,
        ack_timeout: Duration,
    ) -> ReactOutcome {
        if message_id.is_empty() || emoji.is_empty() {
            return ReactOutcome::NotSent {
                reason: "ID または絵文字が空です".into(),
            };
        }
        if !self.sendable {
            return ReactOutcome::NotSent {
                reason: NOT_CONNECTED.into(),
            };
        }
        if self.last_sent.elapsed() >= self.idle_timeout {
            return ReactOutcome::NotSent {
                reason: IDLE_REASON.into(),
            };
        }
        let event = if add {
            ClientEvent::ReactionAdd {
                message_id: message_id.to_owned(),
                emoji: emoji.to_owned(),
            }
        } else {
            ClientEvent::ReactionRemove {
                message_id: message_id.to_owned(),
                emoji: emoji.to_owned(),
            }
        };
        let text = match serde_json::to_string(&event) {
            Ok(text) => text,
            Err(err) => {
                return ReactOutcome::NotSent {
                    reason: format!("送信データを作れません: {err}"),
                };
            }
        };
        let deadline = TokioInstant::now() + ack_timeout;
        match timeout_at(deadline, self.socket.send(WsMessage::Text(text.into()))).await {
            Err(_) => {
                self.sendable = false;
                return ReactOutcome::Unknown(UnknownReason::Timeout);
            }
            Ok(Err(_)) => {
                self.sendable = false;
                return ReactOutcome::Unknown(UnknownReason::WriteFailed);
            }
            Ok(Ok(())) => self.last_sent = TokioInstant::now(),
        }
        loop {
            let next = match timeout_at(deadline, self.socket.next()).await {
                Err(_) => return ReactOutcome::Unknown(UnknownReason::Timeout),
                Ok(next) => next,
            };
            match next {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => {
                    self.sendable = false;
                    return ReactOutcome::Unknown(UnknownReason::Disconnected);
                }
                Some(Ok(WsMessage::Text(text))) => {
                    let Ok(event) = serde_json::from_str::<ServerEvent>(text.as_str()) else {
                        continue;
                    };
                    match event {
                        ServerEvent::ReactionUpdated {
                            message_id: id,
                            reactions,
                        } if id == message_id => {
                            let mine = reactions
                                .iter()
                                .any(|r| r.emoji == emoji && r.user_ids.contains(&self.me.id));
                            if mine == add {
                                return ReactOutcome::Confirmed;
                            }
                        }
                        ServerEvent::Error { code, message, .. } => {
                            return ReactOutcome::Rejected { code, message };
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Ping(_))) => {
                    match timeout_at(deadline, self.socket.flush()).await {
                        Err(_) => return ReactOutcome::Unknown(UnknownReason::Timeout),
                        Ok(Err(_)) => {
                            self.sendable = false;
                            return ReactOutcome::Unknown(UnknownReason::Disconnected);
                        }
                        Ok(Ok(())) => self.last_sent = TokioInstant::now(),
                    }
                }
                Some(Ok(_)) => {}
            }
        }
    }

    /// Wait for the next server event. Cancel-safe: dropping the future loses no events.
    ///
    /// WebSocket ping frames are answered internally and are not returned. Returns a
    /// `Disconnected` with reason `"idle timeout"` if no frame arrives within `idle_timeout`.
    pub async fn next_event(&mut self) -> Result<ServerEvent, Disconnected> {
        loop {
            let frame = match timeout(self.idle_timeout, self.socket.next()).await {
                Err(_) => return Err(self.disconnected("idle timeout".into())),
                Ok(frame) => frame,
            };
            let reason = match frame {
                Some(Ok(WsMessage::Text(text))) => {
                    match serde_json::from_str::<ServerEvent>(text.as_str()) {
                        Ok(event) => return Ok(event),
                        // An event this client does not know (for example from a newer server).
                        Err(_) => continue,
                    }
                }
                Some(Ok(WsMessage::Ping(_))) => match self.socket.flush().await {
                    Ok(()) => {
                        self.last_sent = TokioInstant::now();
                        continue;
                    }
                    Err(err) => err.to_string(),
                },
                Some(Ok(WsMessage::Close(_))) => "サーバーが接続を閉じました".to_owned(),
                Some(Ok(_)) => continue,
                Some(Err(err)) => err.to_string(),
                None => "接続が閉じられました".to_owned(),
            };
            return Err(self.disconnected(reason));
        }
    }

    fn disconnected(&mut self, reason: String) -> Disconnected {
        self.sendable = false;
        Disconnected { reason }
    }

    /// Send a close frame and drop the connection. The close frame is sent with a short timeout.
    pub async fn close(mut self) {
        let _ = timeout(Duration::from_secs(2), self.socket.close(None)).await;
    }
}

/// Checks shared by every send path. Nothing is written for an invalid request. The server
/// decides the rest (missing targets, and so on) and answers with a code.
fn validate_send(client_id: &str, request: &SendRequest) -> Result<(), String> {
    if client_id.is_empty() {
        return Err("client_id が空です".into());
    }
    // The server accepts an empty body when there are attachments.
    if request.body.trim().is_empty() && request.attachment_ids.is_empty() {
        return Err("本文が空です".into());
    }
    if request.body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("本文は{MAX_BODY_CHARS}文字までです"));
    }
    let ids = request.reply_to.iter().chain(request.attachment_ids.iter());
    if ids.into_iter().any(String::is_empty) {
        return Err("ID が空です".into());
    }
    Ok(())
}

/// The `message.send` frame for a main-chat message.
fn send_frame(client_id: &str, request: &SendRequest) -> Result<String, serde_json::Error> {
    serde_json::to_string(&ClientEvent::MessageSend {
        client_id: client_id.to_owned(),
        body: request.body.clone(),
        attachment_ids: request.attachment_ids.clone(),
        reply_to: request.reply_to.clone(),
        silent: request.silent,
    })
}

fn unknown(client_id: String, reason: UnknownReason) -> SendOutcome {
    SendOutcome::Unknown { client_id, reason }
}

fn client_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
}

async fn wait_for_hello(
    socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
) -> Result<(User, Vec<User>), WsError> {
    loop {
        match socket.next().await {
            None => {
                return Err(WsError::Protocol("hello の前に接続が閉じられました".into()));
            }
            Some(Err(err)) => {
                return Err(WsError::Protocol(format!(
                    "hello の前に接続が失敗しました: {err}"
                )));
            }
            Some(Ok(WsMessage::Close(_))) => {
                return Err(WsError::Protocol(
                    "hello の前にサーバーが接続を閉じました".into(),
                ));
            }
            Some(Ok(WsMessage::Text(text))) => {
                if let Ok(ServerEvent::Hello { me, users }) =
                    serde_json::from_str::<ServerEvent>(text.as_str())
                {
                    return Ok((me, users));
                }
            }
            Some(Ok(WsMessage::Ping(_))) => {
                socket.flush().await.map_err(|err| {
                    WsError::Protocol(format!("hello の前に接続が失敗しました: {err}"))
                })?;
            }
            Some(Ok(_)) => {}
        }
    }
}

fn websocket_url(server: &ServerUrl) -> Result<Url, WsError> {
    Url::parse(&server.ws_url("/api/ws")).map_err(|err| WsError::InvalidUrl(err.to_string()))
}

/// Visible ASCII only: the server reads the header as text and ignores non-ASCII values.
fn validate_dev_user(user: &str) -> Result<(), WsError> {
    if user.trim().is_empty() || !user.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err(WsError::InvalidDevUser);
    }
    Ok(())
}

fn build_request(url: &Url, dev_user: Option<&str>) -> Result<Request, WsError> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|err| WsError::InvalidUrl(err.to_string()))?;
    if let Some(user) = dev_user {
        validate_dev_user(user)?;
        let value = HeaderValue::from_str(user).map_err(|_| WsError::InvalidDevUser)?;
        request.headers_mut().insert(DEV_USER_HEADER, value);
    }
    Ok(request)
}

fn map_connect_error(err: tungstenite::Error) -> WsError {
    match err {
        tungstenite::Error::Http(response) => WsError::Http {
            status: response.status().as_u16(),
        },
        tungstenite::Error::Url(err) => WsError::InvalidUrl(err.to_string()),
        other => WsError::Connect(other.to_string()),
    }
}

/// One item from [`ChatWatch::next`] or [`ChatSession::next`]. Every item carries the generation of
/// the connection it belongs to, except [`WatchItem::Connecting`]. Generation 1 is the first
/// connection. See the module docs for the refetch rules.
// The event payload is the wire type itself, so the size gap is accepted rather than boxed.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum WatchItem {
    /// A reconnect attempt is starting. `attempt` counts from 1 within one outage and restarts
    /// when a connection is up. Informational only: [`ChatWatch`] does not return it.
    Connecting { attempt: u32 },
    /// A connection is ready (the first one, or after a reconnect). `users` is the list from
    /// `hello` on that connection.
    Connected {
        generation: u64,
        me: User,
        users: Vec<User>,
    },
    /// A server event from this generation's connection. In a [`ChatSession`] this includes the
    /// `message.created` that confirms one of its own sends, and the `error` events for them.
    Event { generation: u64, event: ServerEvent },
    /// Events may have been lost. For a disconnect, wait for `Connected { generation >= 2 }` and
    /// then refetch over REST. For `"lagged"`, refetch now (see the module docs).
    Gap { generation: u64, reason: String },
    /// Reconnecting stopped for a reason that retrying cannot fix (HTTP 401 or 403). This is
    /// terminal: after it is returned, every later `next()` returns the same `Failed`.
    Failed {
        reason: String,
        http_status: Option<u16>,
    },
}

/// Reconnecting event subscription. Dropping it stops the background task.
pub struct ChatWatch {
    session: ChatSession,
}

impl ChatWatch {
    /// Open the first connection. If it fails, returns the error and does not retry.
    /// Must be called inside a Tokio runtime (the reconnect loop runs as a spawned task).
    pub async fn start(server: &ServerUrl, opts: ConnectOptions) -> Result<Self, WsError> {
        Self::start_with(server, opts, Tuning::DEFAULT).await
    }

    async fn start_with(
        server: &ServerUrl,
        opts: ConnectOptions,
        tuning: Tuning,
    ) -> Result<Self, WsError> {
        Ok(Self {
            session: ChatSession::start_with(server, opts, tuning).await?,
        })
    }

    /// Wait for the next item. Cancel-safe: items stay queued if the future is dropped.
    /// [`WatchItem::Connecting`] is not returned here.
    pub async fn next(&mut self) -> WatchItem {
        loop {
            match self.session.next().await {
                WatchItem::Connecting { .. } => continue,
                item => return item,
            }
        }
    }

    /// Stop reconnecting, close the current connection, and wait briefly for the task to end.
    pub async fn close(self) {
        self.session.close().await;
    }
}

/// A reconnecting WebSocket session: it reads events with [`ChatSession::next`] and sends
/// messages through [`SessionSender`], both over the same connection. Dropping it stops the
/// background task.
///
/// Receiving follows the same rules as [`ChatWatch`] (gap, refetch, `Failed`, bounded queue),
/// plus [`WatchItem::Connecting`] before each reconnect attempt.
///
/// Sending:
/// - A send while the session is not connected (reconnecting, or after a terminal failure)
///   returns [`SendOutcome::NotSent`] and writes nothing.
/// - A send is settled only by a `message.created` with its own `client_id` on the current
///   connection (`Confirmed`), or by an `error` with its own `client_id` (`Rejected` for the
///   allowlisted codes, `Unknown` otherwise). Errors for other IDs, and errors without an ID, do
///   not settle it; such a send ends as `Unknown { Timeout }` at its `ack_timeout`.
/// - If the connection ends before the send is settled, it is `Unknown { Disconnected }`. Sends
///   are never retried automatically, even after reconnecting.
/// - Sends may run concurrently. Each `client_id` is independent; a `client_id` that is already
///   waiting for its acknowledgement is refused with `NotSent`.
/// - Every server event is delivered through `next()`, including the confirmations of this
///   session's own sends (the UI removes duplicates by ID).
pub struct ChatSession {
    shared: Arc<Shared>,
    commands: mpsc::Sender<Command>,
    reconnect: watch::Sender<u64>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl ChatSession {
    /// Open the first connection. If it fails, returns the error and does not retry.
    /// Must be called inside a Tokio runtime.
    pub async fn start(server: &ServerUrl, opts: ConnectOptions) -> Result<Self, WsError> {
        Self::start_with(server, opts, Tuning::DEFAULT).await
    }

    async fn start_with(
        server: &ServerUrl,
        opts: ConnectOptions,
        tuning: Tuning,
    ) -> Result<Self, WsError> {
        let conn = ChatConnection::connect(server, opts.clone()).await?;
        let shared = Arc::new(Shared::new(tuning.queue_capacity));
        shared.push_control(connected(1, &conn), 1);
        let (shutdown, shutdown_rx) = oneshot::channel();
        let (commands_tx, commands) = mpsc::channel(COMMAND_QUEUE);
        let (reconnect, reconnect_rx) = watch::channel(0u64);
        let link = Link {
            server: server.clone(),
            opts,
            tuning,
            shared: shared.clone(),
            commands,
            reconnect: reconnect_rx,
            shutdown: shutdown_rx,
        };
        let task = tokio::spawn(run_session(link, conn));
        Ok(Self {
            shared,
            commands: commands_tx,
            reconnect,
            shutdown: Some(shutdown),
            task: Some(task),
        })
    }

    /// A cloneable handle for sending over this session.
    pub fn sender(&self) -> SessionSender {
        SessionSender {
            commands: self.commands.clone(),
        }
    }

    /// Reconnect now if the session is waiting out a backoff: the wait ends and the next attempt
    /// starts at once, and the backoff restarts from its first step. Does nothing while
    /// connected, while an attempt is in progress, or after a terminal failure.
    pub fn reconnect_now(&self) {
        self.reconnect
            .send_modify(|count| *count = count.wrapping_add(1));
    }

    /// Wait for the next item. Cancel-safe: items stay queued if the future is dropped.
    pub async fn next(&mut self) -> WatchItem {
        loop {
            let item = {
                let mut state = self.shared.lock();
                match state.queue.pop_front() {
                    Some(item) => Some(item),
                    None => state.terminal.clone(),
                }
            };
            if let Some(item) = item {
                return item;
            }
            self.shared.notify.notified().await;
        }
    }

    /// Stop reconnecting, settle pending sends as `Unknown`, close the connection, and wait
    /// briefly for the task to end. Sends made afterwards return `NotSent`.
    pub async fn close(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            let abort = task.abort_handle();
            if timeout(Duration::from_secs(2), task).await.is_err() {
                abort.abort();
            }
        }
    }
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// One message to send, with the optional fields of `message.send`. `Default` is a plain
/// main-chat message with an empty body; set `body` before sending.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendRequest {
    pub body: String,
    /// Attachment IDs from `POST /api/files`. A body may be empty when attachments are given.
    pub attachment_ids: Vec<String>,
    /// Reply target (a message in the main chat).
    pub reply_to: Option<String>,
    pub silent: bool,
}

/// Why [`SessionSender::emit`] did not deliver an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitError {
    /// Not connected. Nothing was written.
    NotConnected,
    /// The write failed or timed out, so delivery is unknown. The connection is being replaced.
    WriteFailed,
    /// `message.send` must go through [`SessionSender::send_request`], which tracks the
    /// acknowledgement. Nothing was written.
    SendNotAllowed,
}

impl fmt::Display for EmitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConnected => write!(f, "接続していないため送信しませんでした"),
            Self::WriteFailed => write!(f, "送信に失敗したか、結果が不明です"),
            Self::SendNotAllowed => {
                write!(f, "message.send は send_request で送ってください")
            }
        }
    }
}

impl std::error::Error for EmitError {}

/// Cloneable handle for sending over a [`ChatSession`]. Sends may run concurrently.
#[derive(Clone)]
pub struct SessionSender {
    commands: mpsc::Sender<Command>,
}

impl SessionSender {
    /// Send one main-chat message (no attachments, no reply) with the caller's
    /// `client_id`. See [`ChatSession`] for the outcome rules. `client_id` must be unique per
    /// logical message; a duplicate of a pending ID is refused with `NotSent`.
    pub async fn send(
        &self,
        client_id: &str,
        body: &str,
        silent: bool,
        ack_timeout: Duration,
    ) -> SendOutcome {
        let request = SendRequest {
            body: body.to_owned(),
            silent,
            ..SendRequest::default()
        };
        self.send_request(client_id, request, ack_timeout).await
    }

    /// Send one message with all `message.send` options. Same outcome rules as
    /// [`SessionSender::send`].
    pub async fn send_request(
        &self,
        client_id: &str,
        request: SendRequest,
        ack_timeout: Duration,
    ) -> SendOutcome {
        if let Err(reason) = validate_send(client_id, &request) {
            return SendOutcome::NotSent { reason };
        }
        let (reply, outcome) = oneshot::channel();
        let command = Command::Send(Outgoing {
            client_id: client_id.to_owned(),
            request,
            ack_timeout,
            reply,
        });
        if self.commands.send(command).await.is_err() {
            return SendOutcome::NotSent {
                reason: SESSION_ENDED.into(),
            };
        }
        // The task dropped the request without answering it (it was aborted): the outcome is
        // not known, so report Unknown rather than claim it was not sent.
        outcome
            .await
            .unwrap_or_else(|_| unknown(client_id.to_owned(), UnknownReason::Disconnected))
    }

    /// Send an event that has no acknowledgement (edit, delete, reaction, call
    /// and plugin signalling). Returns once the frame is written. The server gives no per-event
    /// confirmation; its result, if any, arrives as an event on `next()`.
    pub async fn emit(&self, event: ClientEvent) -> Result<(), EmitError> {
        if matches!(event, ClientEvent::MessageSend { .. }) {
            return Err(EmitError::SendNotAllowed);
        }
        let (reply, outcome) = oneshot::channel();
        if self
            .commands
            .send(Command::Emit { event, reply })
            .await
            .is_err()
        {
            return Err(EmitError::NotConnected);
        }
        outcome.await.unwrap_or(Err(EmitError::WriteFailed))
    }
}

/// Connection-independent state of a session task.
struct Link {
    server: ServerUrl,
    opts: ConnectOptions,
    tuning: Tuning,
    shared: Arc<Shared>,
    commands: mpsc::Receiver<Command>,
    reconnect: watch::Receiver<u64>,
    shutdown: oneshot::Receiver<()>,
}

/// A request from a [`SessionSender`] to the session task.
enum Command {
    Send(Outgoing),
    Emit {
        event: ClientEvent,
        reply: oneshot::Sender<Result<(), EmitError>>,
    },
}

/// A send to write, answered exactly once on `reply`.
struct Outgoing {
    client_id: String,
    request: SendRequest,
    ack_timeout: Duration,
    reply: oneshot::Sender<SendOutcome>,
}

/// A send written to the current connection and waiting for its acknowledgement.
struct PendingSend {
    deadline: TokioInstant,
    reply: oneshot::Sender<SendOutcome>,
}

/// Sends waiting for acknowledgement on one connection, keyed by `client_id`.
type Pending = HashMap<String, PendingSend>;

enum Pumped {
    Shutdown,
    Ended(String),
}

fn connected(generation: u64, conn: &ChatConnection) -> WatchItem {
    WatchItem::Connected {
        generation,
        me: conn.me.clone(),
        users: conn.users.clone(),
    }
}

/// Session task: runs connections one after another, reconnecting with backoff.
async fn run_session(mut link: Link, first: ChatConnection) {
    let mut generation = 1;
    let mut conn = first;
    let mut failures: u32 = 0;
    loop {
        let started = TokioInstant::now();
        let reason = match pump(conn, &mut link, generation).await {
            Pumped::Shutdown => break,
            Pumped::Ended(reason) => reason,
        };
        failures = failures_after_disconnect(failures, started.elapsed(), &link.tuning);
        link.shared
            .push_control(WatchItem::Gap { generation, reason }, generation);
        conn = match reconnect(&mut link, &mut failures, generation).await {
            Some(next) => next,
            None => break,
        };
        generation += 1;
        link.shared
            .push_control(connected(generation, &conn), generation);
    }
    // Stopped: refuse anything still queued, so those callers get NotSent rather than Unknown.
    link.commands.close();
    while let Ok(command) = link.commands.try_recv() {
        refuse_command(command, NOT_CONNECTED);
    }
}

/// Serve one connection until it ends or the session is shut down. Every send still pending
/// when this returns is settled, and the connection is dropped before any backoff starts.
async fn pump(mut conn: ChatConnection, link: &mut Link, generation: u64) -> Pumped {
    let mut pending = Pending::new();
    let outcome = loop {
        let expiry = pending.values().map(|send| send.deadline).min();
        tokio::select! {
            _ = &mut link.shutdown => break Pumped::Shutdown,
            command = next_command(&mut link.commands) => {
                if let Err(reason) = run_command(&mut conn, &mut pending, command).await {
                    break Pumped::Ended(reason);
                }
            }
            _ = wait_until(expiry) => expire(&mut pending, TokioInstant::now()),
            result = conn.next_event() => match result {
                Ok(event) => route(&link.shared, generation, &mut pending, event),
                Err(Disconnected { reason }) => break Pumped::Ended(reason),
            },
        }
    };
    // Nothing sent on this connection can be confirmed any more.
    for (client_id, send) in pending.drain() {
        let _ = send
            .reply
            .send(unknown(client_id, UnknownReason::Disconnected));
    }
    match outcome {
        Pumped::Shutdown => conn.close().await,
        Pumped::Ended(_) => drop(conn),
    }
    outcome
}

/// Wait for the next command. Pends forever once the channel is closed, so it never ends the
/// select loop by itself.
async fn next_command(commands: &mut mpsc::Receiver<Command>) -> Command {
    match commands.recv().await {
        Some(command) => command,
        None => std::future::pending().await,
    }
}

async fn wait_until(deadline: Option<TokioInstant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Run one command on the live connection. `Err` ends the connection (a failed write may have
/// left a partial frame in the socket buffer).
async fn run_command(
    conn: &mut ChatConnection,
    pending: &mut Pending,
    command: Command,
) -> Result<(), String> {
    match command {
        Command::Send(outgoing) => start_send(conn, pending, outgoing).await,
        Command::Emit { event, reply } => emit_frame(conn, event, reply).await,
    }
}

/// Write one send. The request is registered in `pending` before the write, so its
/// acknowledgement cannot arrive unmatched. A failed or timed-out write ends the connection,
/// since a partial frame may be buffered; `Err` carries the reason.
async fn start_send(
    conn: &mut ChatConnection,
    pending: &mut Pending,
    outgoing: Outgoing,
) -> Result<(), String> {
    if pending.contains_key(&outgoing.client_id) {
        refuse_send(outgoing, DUPLICATE_ID);
        return Ok(());
    }
    if conn.last_sent.elapsed() >= conn.idle_timeout {
        refuse_send(outgoing, IDLE_REASON);
        return Ok(());
    }
    let text = match send_frame(&outgoing.client_id, &outgoing.request) {
        Ok(text) => text,
        Err(err) => {
            refuse_send(outgoing, &format!("送信データを作れません: {err}"));
            return Ok(());
        }
    };
    let client_id = outgoing.client_id.clone();
    pending.insert(
        client_id.clone(),
        PendingSend {
            deadline: TokioInstant::now() + outgoing.ack_timeout,
            reply: outgoing.reply,
        },
    );
    match timeout(
        WRITE_TIMEOUT,
        conn.socket.send(WsMessage::Text(text.into())),
    )
    .await
    {
        Ok(Ok(())) => {
            conn.last_sent = TokioInstant::now();
            Ok(())
        }
        Ok(Err(_)) => {
            settle_one(pending, &client_id, UnknownReason::WriteFailed);
            Err("write failed".into())
        }
        Err(_) => {
            settle_one(pending, &client_id, UnknownReason::Timeout);
            Err("write timeout".into())
        }
    }
}

/// Write one event that has no acknowledgement. Refused (not written) when the connection has
/// been silent too long, as for sends.
async fn emit_frame(
    conn: &mut ChatConnection,
    event: ClientEvent,
    reply: oneshot::Sender<Result<(), EmitError>>,
) -> Result<(), String> {
    if conn.last_sent.elapsed() >= conn.idle_timeout {
        let _ = reply.send(Err(EmitError::NotConnected));
        return Ok(());
    }
    let text = match serde_json::to_string(&event) {
        Ok(text) => text,
        Err(_) => {
            let _ = reply.send(Err(EmitError::WriteFailed));
            return Ok(());
        }
    };
    match timeout(
        WRITE_TIMEOUT,
        conn.socket.send(WsMessage::Text(text.into())),
    )
    .await
    {
        Ok(Ok(())) => {
            conn.last_sent = TokioInstant::now();
            let _ = reply.send(Ok(()));
            Ok(())
        }
        Ok(Err(_)) => {
            let _ = reply.send(Err(EmitError::WriteFailed));
            Err("write failed".into())
        }
        Err(_) => {
            let _ = reply.send(Err(EmitError::WriteFailed));
            Err("write timeout".into())
        }
    }
}

/// Route one server event: queue it, and if it settles a pending send, answer that send.
/// The event is queued first, so a caller that sees `Confirmed` finds the event already queued.
fn route(shared: &Shared, generation: u64, pending: &mut Pending, event: ServerEvent) {
    let settled = match &event {
        ServerEvent::MessageCreated {
            client_id: Some(id),
            message,
        } if pending.contains_key(id) => Some((
            id.clone(),
            SendOutcome::Confirmed {
                client_id: id.clone(),
                message: message.clone(),
            },
        )),
        ServerEvent::Error {
            client_id: Some(id),
            code,
            message,
        } if pending.contains_key(id) => {
            let outcome = if REJECTED_CODES.contains(&code.as_str()) {
                SendOutcome::Rejected {
                    client_id: id.clone(),
                    code: code.clone(),
                    message: message.clone(),
                }
            } else {
                unknown(
                    id.clone(),
                    UnknownReason::ServerError {
                        code: code.clone(),
                        message: message.clone(),
                    },
                )
            };
            Some((id.clone(), outcome))
        }
        _ => None,
    };
    shared.push_event(generation, event);
    if let Some((client_id, outcome)) = settled {
        settle_with(pending, &client_id, outcome);
    }
}

/// Answer every pending send whose acknowledgement deadline has passed.
fn expire(pending: &mut Pending, now: TokioInstant) {
    let due: Vec<String> = pending
        .iter()
        .filter(|(_, send)| send.deadline <= now)
        .map(|(client_id, _)| client_id.clone())
        .collect();
    for client_id in due {
        settle_one(pending, &client_id, UnknownReason::Timeout);
    }
}

fn settle_one(pending: &mut Pending, client_id: &str, reason: UnknownReason) {
    settle_with(pending, client_id, unknown(client_id.to_owned(), reason));
}

fn settle_with(pending: &mut Pending, client_id: &str, outcome: SendOutcome) {
    if let Some(send) = pending.remove(client_id) {
        let _ = send.reply.send(outcome);
    }
}

fn refuse_send(outgoing: Outgoing, reason: &str) {
    let _ = outgoing.reply.send(SendOutcome::NotSent {
        reason: reason.to_owned(),
    });
}

/// Refuse a command without writing anything.
fn refuse_command(command: Command, reason: &str) {
    match command {
        Command::Send(outgoing) => refuse_send(outgoing, reason),
        Command::Emit { reply, .. } => {
            let _ = reply.send(Err(EmitError::NotConnected));
        }
    }
}

/// Run `work` to completion while refusing commands. `None` if shutdown arrives first.
async fn while_offline<F: Future>(
    work: F,
    shutdown: &mut oneshot::Receiver<()>,
    commands: &mut mpsc::Receiver<Command>,
) -> Option<F::Output> {
    tokio::pin!(work);
    loop {
        tokio::select! {
            _ = &mut *shutdown => return None,
            output = &mut work => return Some(output),
            command = next_command(commands) => refuse_command(command, NOT_CONNECTED),
        }
    }
}

/// Sleep for `wait`, or return early when [`ChatSession::reconnect_now`] is called. `true` if
/// woken early. Calls made before this wait starts are ignored.
async fn backoff_wait(wait: Duration, reconnect: &mut watch::Receiver<u64>) -> bool {
    reconnect.borrow_and_update();
    tokio::select! {
        _ = sleep(jittered(wait)) => false,
        changed = reconnect.changed() => changed.is_ok(),
    }
}

/// Back off and reconnect until a connection is up. `None` means stop: shutdown, or a terminal
/// failure (recorded in `shared` as `Failed`). Sends are refused while this runs.
async fn reconnect(link: &mut Link, failures: &mut u32, generation: u64) -> Option<ChatConnection> {
    let mut attempt: u32 = 0;
    loop {
        let wait = backoff_delay(*failures, &link.tuning);
        *failures = failures.saturating_add(1);
        let woken = while_offline(
            backoff_wait(wait, &mut link.reconnect),
            &mut link.shutdown,
            &mut link.commands,
        )
        .await?;
        if woken {
            // An explicit reconnect starts the backoff from its first step again.
            *failures = 0;
        }
        attempt += 1;
        link.shared
            .push_control(WatchItem::Connecting { attempt }, generation);
        let server = link.server.clone();
        let opts = link.opts.clone();
        let result = while_offline(
            ChatConnection::connect(&server, opts),
            &mut link.shutdown,
            &mut link.commands,
        )
        .await?;
        match result {
            Ok(conn) => return Some(conn),
            Err(WsError::Http { status }) if status == 401 || status == 403 => {
                link.shared.fail(WatchItem::Failed {
                    reason: WsError::Http { status }.to_string(),
                    http_status: Some(status),
                });
                return None;
            }
            Err(_) => {}
        }
    }
}

/// Reconnect timing and queue size. Tests use short values.
#[derive(Debug, Clone, Copy)]
struct Tuning {
    backoff_min: Duration,
    backoff_max: Duration,
    /// A connection that lived at least this long resets the backoff.
    stable_after: Duration,
    queue_capacity: usize,
}

impl Tuning {
    const DEFAULT: Self = Self {
        backoff_min: Duration::from_secs(1),
        backoff_max: Duration::from_secs(30),
        stable_after: STABLE_CONNECTION,
        queue_capacity: 256,
    };
}

/// Delay before the reconnect attempt that follows `failures` earlier failures:
/// `min * 2^failures`, capped at `max`.
fn backoff_delay(failures: u32, tuning: &Tuning) -> Duration {
    let factor = 1u32.checked_shl(failures.min(31)).unwrap_or(u32::MAX);
    tuning
        .backoff_min
        .saturating_mul(factor)
        .min(tuning.backoff_max)
}

/// Failure count after a disconnect. Only a connection that lived long enough counts as stable.
fn failures_after_disconnect(failures: u32, lived: Duration, tuning: &Tuning) -> u32 {
    if lived >= tuning.stable_after {
        0
    } else {
        failures
    }
}

struct State {
    /// Bounded. Events are dropped on overflow; control items are collapsed (see `collapse`).
    queue: VecDeque<WatchItem>,
    /// Set once by a terminal failure. Returned after the queue is drained, and forever after.
    terminal: Option<WatchItem>,
}

struct Shared {
    state: Mutex<State>,
    capacity: usize,
    notify: Notify,
}

impl Shared {
    fn new(capacity: usize) -> Self {
        Self {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                terminal: None,
            }),
            // Collapsing leaves at most two items, so a control item always fits in three.
            capacity: capacity.max(3),
            notify: Notify::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Connection state changes are queued. When the queue is full they are collapsed, never
    /// allowed to grow without bound. `generation` is the one the change belongs to.
    fn push_control(&self, item: WatchItem, generation: u64) {
        {
            let mut state = self.lock();
            if state.queue.len() >= self.capacity {
                collapse(&mut state.queue, generation);
            }
            state.queue.push_back(item);
        }
        self.notify.notify_one();
    }

    /// Queue an event. When the queue is full, queued events are dropped and replaced by one
    /// `lagged` gap, so the consumer knows to refetch rather than silently missing events.
    fn push_event(&self, generation: u64, event: ServerEvent) {
        {
            let mut state = self.lock();
            if state.queue.len() < self.capacity {
                state
                    .queue
                    .push_back(WatchItem::Event { generation, event });
            } else {
                collapse(&mut state.queue, generation);
            }
        }
        self.notify.notify_one();
    }

    fn fail(&self, item: WatchItem) {
        self.lock().terminal = Some(item);
        self.notify.notify_one();
    }
}

/// Replace the queued items by at most: the newest `Connected` (so a reconnect stays visible)
/// and one `lagged` gap. Events and older control items are dropped; the gap tells the consumer
/// to refetch history, which covers everything dropped.
fn collapse(queue: &mut VecDeque<WatchItem>, generation: u64) {
    let newest_connected = queue
        .iter()
        .rev()
        .find(|item| matches!(item, WatchItem::Connected { .. }))
        .cloned();
    queue.clear();
    if let Some(connected) = newest_connected {
        queue.push_back(connected);
    }
    queue.push_back(WatchItem::Gap {
        generation,
        reason: LAGGED.into(),
    });
}

/// A random delay in `[delay/2, delay]`.
fn jittered(delay: Duration) -> Duration {
    let millis = delay.as_millis() as u64;
    let half = millis / 2;
    Duration::from_millis(half + fastrand::u64(0..=half))
}

#[cfg(test)]
mod tests {
    // Handshake callbacks return tungstenite's own (large) HTTP response type.
    #![allow(clippy::result_large_err, clippy::large_enum_variant)]

    use std::{future::Future, sync::Mutex as StdMutex};

    use tokio::{net::TcpListener, sync::mpsc};
    use tokio_tungstenite::{
        accept_async, accept_hdr_async,
        tungstenite::{
            handshake::server::{ErrorResponse, Request, Response},
            http,
        },
    };

    use super::*;

    const WAIT: Duration = Duration::from_secs(5);

    type Socket = WebSocketStream<TcpStream>;
    type Seen = Arc<StdMutex<Vec<ClientEvent>>>;

    /// Accepts connections on 127.0.0.1 and runs `script` for each one, numbered from zero.
    async fn serve<F, Fut>(script: F) -> ServerUrl
    where
        F: Fn(usize, TcpStream) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut index = 0;
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(script(index, stream));
                index += 1;
            }
        });
        ServerUrl::parse(&format!("http://{address}")).unwrap()
    }

    fn user(login: &str) -> User {
        User {
            id: format!("id-{login}"),
            login_name: login.into(),
            display_name: login.into(),
            avatar_url: None,
            created_at: 1,
        }
    }

    fn message(id: &str, body: &str) -> Message {
        Message {
            id: id.into(),
            author_id: "id-alice".into(),
            reply_to: None,
            reply_preview: None,
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1,
            edited_at: None,
            card: None,
            bot: None,
        }
    }

    fn hello() -> ServerEvent {
        ServerEvent::Hello {
            me: user("alice@test"),
            users: vec![user("alice@test")],
        }
    }

    fn json(event: &ServerEvent) -> WsMessage {
        WsMessage::Text(serde_json::to_string(event).unwrap().into())
    }

    /// Next frame from the peer, or `None` on close, error, or timeout.
    async fn read_frame(socket: &mut Socket) -> Option<WsMessage> {
        match timeout(WAIT, socket.next()).await {
            Ok(Some(Ok(frame))) => Some(frame),
            _ => None,
        }
    }

    /// Next `message.send` from the client, skipping control frames.
    async fn read_client(socket: &mut Socket) -> Option<ClientEvent> {
        loop {
            match read_frame(socket).await? {
                WsMessage::Text(text) => return serde_json::from_str(text.as_str()).ok(),
                WsMessage::Close(_) => return None,
                _ => {}
            }
        }
    }

    /// What the scripted server does after receiving a `message.send`.
    enum Step {
        Event(ServerEvent),
        Close,
    }

    /// Scripted chat server: sends `hello`, records every `message.send`, and replies with
    /// `reply(event)`.
    async fn serve_chat<R>(seen: Seen, reply: R) -> ServerUrl
    where
        R: Fn(&ClientEvent) -> Vec<Step> + Send + Sync + 'static,
    {
        let reply = Arc::new(reply);
        serve(move |_, stream| {
            let seen = seen.clone();
            let reply = reply.clone();
            async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                if socket.send(json(&hello())).await.is_err() {
                    return;
                }
                while let Some(event) = read_client(&mut socket).await {
                    seen.lock().unwrap().push(event.clone());
                    for step in reply(&event) {
                        match step {
                            Step::Event(event) => {
                                if socket.send(json(&event)).await.is_err() {
                                    return;
                                }
                            }
                            Step::Close => {
                                let _ = socket.close(None).await;
                                return;
                            }
                        }
                    }
                }
            }
        })
        .await
    }

    fn new_seen() -> Seen {
        Arc::new(StdMutex::new(Vec::new()))
    }

    fn sent_ids(seen: &Seen) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                ClientEvent::MessageSend { client_id, .. } => Some(client_id.clone()),
                _ => None,
            })
            .collect()
    }

    fn client_id_of(event: &ClientEvent) -> String {
        match event {
            ClientEvent::MessageSend { client_id, .. } => client_id.clone(),
            other => panic!("unexpected client event: {other:?}"),
        }
    }

    fn body_of(event: &ClientEvent) -> String {
        match event {
            ClientEvent::MessageSend { body, .. } => body.clone(),
            other => panic!("unexpected client event: {other:?}"),
        }
    }

    /// Confirm the send with its own `client_id`.
    fn ack(event: &ClientEvent) -> Step {
        Step::Event(ServerEvent::MessageCreated {
            client_id: Some(client_id_of(event)),
            message: message("m-ack", &body_of(event)),
        })
    }

    fn error_for(client_id: Option<String>, code: &str) -> Step {
        Step::Event(ServerEvent::Error {
            client_id,
            code: code.into(),
            message: "test error".into(),
        })
    }

    async fn connect(server: &ServerUrl) -> ChatConnection {
        timeout(
            WAIT,
            ChatConnection::connect(server, ConnectOptions::default()),
        )
        .await
        .expect("connect timed out")
        .expect("connect failed")
    }

    async fn send(conn: &mut ChatConnection, body: &str) -> SendOutcome {
        conn.send_message(body, true, WAIT).await
    }

    async fn next_item(watch: &mut ChatWatch) -> WatchItem {
        timeout(WAIT, watch.next())
            .await
            .expect("timed out waiting for a watch item")
    }

    fn fast_tuning() -> Tuning {
        Tuning {
            backoff_min: Duration::from_millis(10),
            backoff_max: Duration::from_millis(20),
            ..Tuning::DEFAULT
        }
    }

    // ----- pure helpers -------------------------------------------------------------------

    #[test]
    fn backoff_starts_at_one_second_doubles_and_caps_at_thirty() {
        let tuning = Tuning::DEFAULT;
        assert_eq!(backoff_delay(0, &tuning), Duration::from_secs(1));
        assert_eq!(backoff_delay(1, &tuning), Duration::from_secs(2));
        assert_eq!(backoff_delay(4, &tuning), Duration::from_secs(16));
        assert_eq!(backoff_delay(5, &tuning), Duration::from_secs(30));
        assert_eq!(backoff_delay(500, &tuning), Duration::from_secs(30));
    }

    #[test]
    fn backoff_resets_only_after_a_long_lived_connection() {
        let tuning = Tuning::DEFAULT;
        // A connection that drops right after hello keeps growing the delay.
        assert_eq!(failures_after_disconnect(5, Duration::ZERO, &tuning), 5);
        assert_eq!(
            failures_after_disconnect(5, Duration::from_secs(29), &tuning),
            5
        );
        assert_eq!(
            failures_after_disconnect(5, Duration::from_secs(30), &tuning),
            0
        );
    }

    #[test]
    fn websocket_url_uses_ws_schemes_and_keeps_base_path() {
        let plain = ServerUrl::parse("http://host:8080").unwrap();
        assert_eq!(
            websocket_url(&plain).unwrap().as_str(),
            "ws://host:8080/api/ws"
        );
        let secure = ServerUrl::parse("https://host:8443/base/").unwrap();
        assert_eq!(
            websocket_url(&secure).unwrap().as_str(),
            "wss://host:8443/base/api/ws"
        );
    }

    #[test]
    fn invalid_dev_user_is_rejected_before_connecting() {
        let server = ServerUrl::parse("http://127.0.0.1:9").unwrap();
        let url = websocket_url(&server).unwrap();
        for bad in ["  ", "", "a\nb", "a\tb", "アリス"] {
            assert!(matches!(
                build_request(&url, Some(bad)),
                Err(WsError::InvalidDevUser)
            ));
        }
        assert!(build_request(&url, Some("alice@github")).is_ok());
    }

    #[test]
    fn client_ids_are_unique_ulids() {
        let a = new_client_id();
        let b = new_client_id();
        assert_eq!(a.len(), 26);
        assert_ne!(a, b);
    }

    // ----- connect and hello gate ---------------------------------------------------------

    #[tokio::test]
    async fn connect_sends_dev_user_header_and_ignores_events_before_hello() {
        let seen = Arc::new(StdMutex::new(None::<(String, Option<String>)>));
        let server = {
            let seen = seen.clone();
            serve(move |_, stream| {
                let seen = seen.clone();
                async move {
                    let callback = move |request: &Request,
                                         response: Response|
                          -> Result<Response, ErrorResponse> {
                        let header = request
                            .headers()
                            .get(DEV_USER_HEADER)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        *seen.lock().unwrap() = Some((request.uri().to_string(), header));
                        Ok(response)
                    };
                    let Ok(mut socket) = accept_hdr_async(stream, callback).await else {
                        return;
                    };
                    let _ = socket
                        .send(json(&ServerEvent::UserUpdated {
                            user: user("early"),
                        }))
                        .await;
                    let _ = socket.send(json(&hello())).await;
                    let _ = read_frame(&mut socket).await;
                }
            })
            .await
        };

        let options = ConnectOptions {
            dev_user: Some("a b&c".into()),
            ..ConnectOptions::default()
        };
        let conn = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(conn.me().login_name, "alice@test");
        assert_eq!(conn.users().len(), 1);

        let (uri, header) = seen.lock().unwrap().clone().expect("upgrade seen");
        assert_eq!(uri, "/api/ws", "dev_user must not be in the query string");
        assert_eq!(header.as_deref(), Some("a b&c"));
        conn.close().await;
    }

    #[tokio::test]
    async fn closing_before_hello_is_a_protocol_error() {
        let server = serve(|_, stream| async move {
            if let Ok(mut socket) = accept_async(stream).await {
                let _ = socket.close(None).await;
            }
        })
        .await;
        let result = timeout(
            WAIT,
            ChatConnection::connect(&server, ConnectOptions::default()),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(WsError::Protocol(_))));
    }

    #[tokio::test]
    async fn no_hello_within_hello_timeout_is_a_timeout() {
        let server = serve(|_, stream| async move {
            if let Ok(_socket) = accept_async(stream).await {
                tokio::time::sleep(WAIT).await;
            }
        })
        .await;
        let options = ConnectOptions {
            hello_timeout: Duration::from_millis(100),
            ..ConnectOptions::default()
        };
        let result = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap();
        assert!(matches!(result, Err(WsError::Timeout)));
    }

    #[tokio::test]
    async fn tcp_accept_without_upgrade_times_out_at_connect_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server =
            ServerUrl::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let options = ConnectOptions {
            connect_timeout: Duration::from_millis(100),
            ..ConnectOptions::default()
        };
        let result = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap();
        assert!(matches!(result, Err(WsError::Timeout)));
        drop(listener);
    }

    #[tokio::test]
    async fn upgrade_rejection_is_an_http_error() {
        let server = serve(|_, stream| async move {
            let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                Err(http::Response::builder()
                    .status(401)
                    .body(Some("denied".to_owned()))
                    .unwrap())
            };
            let _ = accept_hdr_async(stream, callback).await;
        })
        .await;
        let result = timeout(
            WAIT,
            ChatConnection::connect(&server, ConnectOptions::default()),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(WsError::Http { status: 401 })));
    }

    // ----- send_message -------------------------------------------------------------------

    #[tokio::test]
    async fn confirmed_when_client_id_matches_and_unrelated_events_are_ignored() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| {
            vec![
                Step::Event(ServerEvent::MessageCreated {
                    client_id: Some("someone-else".into()),
                    message: message("m-other", "other"),
                }),
                Step::Event(ServerEvent::MessageCreated {
                    client_id: None,
                    message: message("m-broadcast", "broadcast"),
                }),
                ack(event),
            ]
        })
        .await;
        let mut conn = connect(&server).await;
        let outcome = send(&mut conn, "hi").await;
        let sent = seen.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        match (&outcome, &sent[0]) {
            (
                SendOutcome::Confirmed { client_id, message },
                ClientEvent::MessageSend {
                    client_id: sent_id,
                    body,
                    silent,
                    reply_to,
                    attachment_ids,
                },
            ) => {
                assert_eq!(client_id, sent_id);
                assert_eq!(message.body, "hi");
                assert_eq!(body, "hi");
                assert!(*silent);
                assert!(reply_to.is_none());
                assert!(attachment_ids.is_empty());
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        conn.close().await;
    }

    #[tokio::test]
    async fn send_message_with_id_uses_the_callers_id_on_the_wire() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
        let mut conn = connect(&server).await;
        let id = new_client_id();
        match conn.send_message_with_id(&id, "hello", false, WAIT).await {
            SendOutcome::Confirmed { client_id, .. } => assert_eq!(client_id, id),
            other => panic!("unexpected outcome: {other:?}"),
        }
        assert_eq!(sent_ids(&seen), vec![id]);
        match conn.send_message_with_id("", "x", false, WAIT).await {
            SendOutcome::NotSent { .. } => {}
            other => panic!("unexpected outcome: {other:?}"),
        }
        conn.close().await;
    }

    #[tokio::test]
    async fn allowlisted_error_for_this_send_is_rejected() {
        let server = serve_chat(new_seen(), |event| {
            vec![error_for(Some(client_id_of(event)), "body_too_long")]
        })
        .await;
        let mut conn = connect(&server).await;
        match send(&mut conn, "long").await {
            SendOutcome::Rejected {
                client_id: _,
                code,
                message,
            } => {
                assert_eq!(code, "body_too_long");
                assert_eq!(message, "test error");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn errors_that_do_not_prove_refusal_stay_unknown_and_connection_survives() {
        let server = serve_chat(new_seen(), |event| match body_of(event).as_str() {
            "internal" => vec![error_for(Some(client_id_of(event)), "internal")],
            "unknown-code" => vec![error_for(Some(client_id_of(event)), "brand_new_code")],
            "no-id" => vec![error_for(None, "reply_not_found")],
            _ => vec![ack(event)],
        })
        .await;
        let mut conn = connect(&server).await;

        match send(&mut conn, "internal").await {
            SendOutcome::Unknown {
                reason: UnknownReason::ServerError { code, .. },
                ..
            } => assert_eq!(code, "internal"),
            other => panic!("unexpected outcome: {other:?}"),
        }
        match send(&mut conn, "unknown-code").await {
            SendOutcome::Unknown {
                reason: UnknownReason::ServerError { code, .. },
                ..
            } => assert_eq!(code, "brand_new_code"),
            other => panic!("unexpected outcome: {other:?}"),
        }
        match send(&mut conn, "no-id").await {
            SendOutcome::Unknown {
                reason: UnknownReason::ServerError { code, .. },
                ..
            } => assert_eq!(code, "reply_not_found"),
            other => panic!("unexpected outcome: {other:?}"),
        }
        assert!(matches!(
            send(&mut conn, "fine").await,
            SendOutcome::Confirmed { .. }
        ));
    }

    #[tokio::test]
    async fn late_error_for_an_earlier_timed_out_send_does_not_affect_the_next_send() {
        // The first send is never acknowledged. Its error arrives while the second send waits.
        let first_id: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let server = {
            let first_id = first_id.clone();
            serve_chat(new_seen(), move |event| {
                let id = client_id_of(event);
                let mut first = first_id.lock().unwrap();
                match first.clone() {
                    None => {
                        *first = Some(id);
                        vec![]
                    }
                    Some(earlier) => vec![
                        error_for(Some(earlier), "body_too_long"),
                        error_for(Some("someone-else".into()), "reply_not_found"),
                        ack(event),
                    ],
                }
            })
            .await
        };
        let mut conn = connect(&server).await;
        assert!(matches!(
            conn.send_message("first", false, Duration::from_millis(200))
                .await,
            SendOutcome::Unknown {
                reason: UnknownReason::Timeout,
                ..
            }
        ));
        match send(&mut conn, "second").await {
            SendOutcome::Confirmed { message, .. } => assert_eq!(message.body, "second"),
            other => panic!("second send was affected: {other:?}"),
        }
        conn.close().await;
    }

    #[tokio::test]
    async fn missing_ack_is_unknown_timeout_and_connection_stays_usable() {
        let server = serve_chat(new_seen(), |event| match body_of(event).as_str() {
            "silent" => vec![],
            _ => vec![ack(event)],
        })
        .await;
        let mut conn = connect(&server).await;
        let outcome = conn
            .send_message("silent", false, Duration::from_millis(200))
            .await;
        assert!(matches!(
            outcome,
            SendOutcome::Unknown {
                reason: UnknownReason::Timeout,
                ..
            }
        ));
        assert!(matches!(
            send(&mut conn, "after").await,
            SendOutcome::Confirmed { .. }
        ));
    }

    #[tokio::test]
    async fn disconnect_before_ack_is_unknown_and_later_sends_are_not_sent() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| match body_of(event).as_str() {
            "drop" => vec![Step::Close],
            _ => vec![ack(event)],
        })
        .await;
        let mut conn = connect(&server).await;
        assert!(matches!(
            send(&mut conn, "drop").await,
            SendOutcome::Unknown {
                reason: UnknownReason::Disconnected,
                ..
            }
        ));
        assert!(matches!(
            send(&mut conn, "after").await,
            SendOutcome::NotSent { .. }
        ));
        assert_eq!(sent_ids(&seen).len(), 1);
    }

    #[tokio::test]
    async fn refused_inputs_write_nothing_to_the_server() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
        let mut conn = connect(&server).await;

        let too_long = "a".repeat(MAX_BODY_CHARS + 1);
        for body in ["", "   \n\t", too_long.as_str()] {
            assert!(matches!(
                send(&mut conn, body).await,
                SendOutcome::NotSent { .. }
            ));
        }
        // The first frame the server sees must be this valid one.
        assert!(matches!(
            send(&mut conn, "ok").await,
            SendOutcome::Confirmed { .. }
        ));
        let sent = seen.lock().unwrap().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(body_of(&sent[0]), "ok");
    }

    #[tokio::test]
    async fn body_at_the_limit_is_sent() {
        let server = serve_chat(new_seen(), |event| vec![ack(event)]).await;
        let mut conn = connect(&server).await;
        let body = "a".repeat(MAX_BODY_CHARS);
        assert!(matches!(
            send(&mut conn, &body).await,
            SendOutcome::Confirmed { .. }
        ));
    }

    #[tokio::test]
    async fn unacknowledged_send_is_never_resent_after_reconnect() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |_| vec![]).await;
        let mut conn = connect(&server).await;
        assert!(matches!(
            conn.send_message("once", false, Duration::from_millis(200))
                .await,
            SendOutcome::Unknown {
                reason: UnknownReason::Timeout,
                ..
            }
        ));
        conn.close().await;

        let mut again = connect(&server).await;
        // Nothing may arrive on the new connection, so a resend would show up here.
        assert!(
            timeout(Duration::from_millis(300), again.next_event())
                .await
                .is_err()
        );
        assert_eq!(sent_ids(&seen).len(), 1);
        again.close().await;
    }

    #[tokio::test]
    async fn send_is_refused_once_the_connection_has_been_silent_for_the_idle_timeout() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
        let options = ConnectOptions {
            idle_timeout: Duration::from_millis(100),
            ..ConnectOptions::default()
        };
        let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap()
            .unwrap();
        // Nothing reads the connection, so no pong is sent and the server would drop it.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(matches!(
            send(&mut conn, "late").await,
            SendOutcome::NotSent { .. }
        ));
        assert!(sent_ids(&seen).is_empty());
    }

    // ----- next_event: ping, idle, size ---------------------------------------------------

    #[tokio::test]
    async fn ping_is_answered_with_pong_and_not_returned() {
        let (pongs, mut pong_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let server = serve(move |_, stream| {
            let pongs = pongs.clone();
            async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let _ = socket.send(json(&hello())).await;
                let _ = socket.send(WsMessage::Ping(b"p".to_vec().into())).await;
                let _ = socket.send(json(&ServerEvent::Pong)).await;
                while let Some(frame) = read_frame(&mut socket).await {
                    if let WsMessage::Pong(payload) = frame {
                        let _ = pongs.send(payload.to_vec());
                        break;
                    }
                }
            }
        })
        .await;

        let mut conn = connect(&server).await;
        assert!(matches!(
            timeout(WAIT, conn.next_event()).await.unwrap(),
            Ok(ServerEvent::Pong)
        ));
        let payload = timeout(WAIT, pong_rx.recv()).await.unwrap().unwrap();
        assert_eq!(payload, b"p");
        conn.close().await;
    }

    #[tokio::test]
    async fn pings_keep_an_otherwise_quiet_connection_alive() {
        // Pings arrive every 50 ms for 300 ms, longer than the 200 ms idle timeout.
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            for _ in 0..6 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = socket.send(WsMessage::Ping(Vec::new().into())).await;
            }
            let _ = socket
                .send(json(&ServerEvent::UserUpdated {
                    user: user("after-pings"),
                }))
                .await;
            let _ = read_frame(&mut socket).await;
        })
        .await;
        let options = ConnectOptions {
            idle_timeout: Duration::from_millis(200),
            ..ConnectOptions::default()
        };
        let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap()
            .unwrap();
        match timeout(WAIT, conn.next_event()).await.unwrap() {
            Ok(ServerEvent::UserUpdated { user }) => assert_eq!(user.login_name, "after-pings"),
            other => panic!("connection dropped during pings: {other:?}"),
        }
        conn.close().await;
    }

    #[tokio::test]
    async fn silence_past_the_idle_timeout_is_a_disconnect() {
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            tokio::time::sleep(WAIT).await;
        })
        .await;
        let options = ConnectOptions {
            idle_timeout: Duration::from_millis(150),
            ..ConnectOptions::default()
        };
        let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
            .await
            .unwrap()
            .unwrap();
        match timeout(WAIT, conn.next_event()).await.unwrap() {
            Err(Disconnected { reason }) => assert_eq!(reason, "idle timeout"),
            other => panic!("expected idle disconnect: {other:?}"),
        }
    }

    #[tokio::test]
    async fn oversized_message_is_a_disconnect_not_a_huge_allocation() {
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let huge = "x".repeat(MAX_MESSAGE_BYTES + 1024);
            let _ = socket.send(WsMessage::Text(huge.into())).await;
            let _ = read_frame(&mut socket).await;
        })
        .await;
        let mut conn = connect(&server).await;
        assert!(matches!(
            timeout(WAIT, conn.next_event()).await.unwrap(),
            Err(Disconnected { .. })
        ));
    }

    // ----- ChatWatch ----------------------------------------------------------------------

    #[tokio::test]
    async fn watch_reports_events_gap_and_reconnect_generation() {
        let server = serve(|index, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let marker = if index == 0 { "one" } else { "two" };
            let _ = socket
                .send(json(&ServerEvent::UserUpdated { user: user(marker) }))
                .await;
            if index == 0 {
                let _ = socket.close(None).await;
            } else {
                let _ = read_frame(&mut socket).await;
            }
        })
        .await;

        let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), fast_tuning())
            .await
            .unwrap();
        match next_item(&mut watch).await {
            WatchItem::Connected {
                generation,
                me,
                users,
            } => {
                assert_eq!(generation, 1);
                assert_eq!(me.login_name, "alice@test");
                assert_eq!(users.len(), 1);
            }
            other => panic!("unexpected item: {other:?}"),
        }
        match next_item(&mut watch).await {
            WatchItem::Event {
                generation,
                event: ServerEvent::UserUpdated { user },
            } => {
                assert_eq!(generation, 1);
                assert_eq!(user.login_name, "one");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        match next_item(&mut watch).await {
            WatchItem::Connected { generation, .. } => assert_eq!(generation, 2),
            other => panic!("unexpected item: {other:?}"),
        }
        match next_item(&mut watch).await {
            WatchItem::Event {
                generation,
                event: ServerEvent::UserUpdated { user },
            } => {
                assert_eq!(generation, 2);
                assert_eq!(user.login_name, "two");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        watch.close().await;
    }

    #[tokio::test]
    async fn watch_treats_idle_silence_as_a_disconnect_and_reconnects() {
        let server = serve(|index, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            if index == 0 {
                // Silent: the client must notice through its idle timeout.
                tokio::time::sleep(WAIT).await;
            } else {
                let _ = socket
                    .send(json(&ServerEvent::UserUpdated {
                        user: user("second"),
                    }))
                    .await;
                let _ = read_frame(&mut socket).await;
            }
        })
        .await;
        let options = ConnectOptions {
            idle_timeout: Duration::from_millis(150),
            ..ConnectOptions::default()
        };
        let mut watch = ChatWatch::start_with(&server, options, fast_tuning())
            .await
            .unwrap();
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        match next_item(&mut watch).await {
            WatchItem::Gap { generation, reason } => {
                assert_eq!(generation, 1);
                assert_eq!(reason, "idle timeout");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Connected { generation: 2, .. }
        ));
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Event { generation: 2, .. }
        ));
        watch.close().await;
    }

    #[tokio::test]
    async fn watch_start_failure_is_returned_without_retrying() {
        let server = serve(|_, stream| async move {
            let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                Err(http::Response::builder()
                    .status(403)
                    .body(Some("forbidden".to_owned()))
                    .unwrap())
            };
            let _ = accept_hdr_async(stream, callback).await;
        })
        .await;
        let result = timeout(WAIT, ChatWatch::start(&server, ConnectOptions::default()))
            .await
            .unwrap();
        assert!(matches!(result, Err(WsError::Http { status: 403 })));
    }

    #[tokio::test]
    async fn rejected_reconnect_is_terminal_and_sticky() {
        let server = serve(|index, stream| async move {
            if index == 0 {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let _ = socket.send(json(&hello())).await;
                let _ = socket.close(None).await;
            } else {
                let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                    Err(http::Response::builder()
                        .status(401)
                        .body(Some("denied".to_owned()))
                        .unwrap())
                };
                let _ = accept_hdr_async(stream, callback).await;
            }
        })
        .await;
        let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), fast_tuning())
            .await
            .unwrap();
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_item(&mut watch).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        for _ in 0..2 {
            match next_item(&mut watch).await {
                WatchItem::Failed {
                    http_status: Some(401),
                    ..
                } => {}
                other => panic!("expected a sticky Failed: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn watch_overflow_is_reported_as_lagged_gap() {
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            for n in 0..10 {
                let _ = socket
                    .send(json(&ServerEvent::UserUpdated {
                        user: user(&format!("u{n}")),
                    }))
                    .await;
            }
            let _ = read_frame(&mut socket).await;
        })
        .await;

        let tuning = Tuning {
            queue_capacity: 3,
            ..fast_tuning()
        };
        let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), tuning)
            .await
            .unwrap();
        // Let the background task read every event before the consumer drains the queue.
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut lagged = false;
        let mut events = Vec::new();
        loop {
            match timeout(Duration::from_millis(500), watch.next()).await {
                Err(_) => break,
                Ok(WatchItem::Gap { reason, .. }) if reason == LAGGED => lagged = true,
                Ok(WatchItem::Event {
                    event: ServerEvent::UserUpdated { user },
                    ..
                }) => events.push(user.login_name),
                Ok(_) => {}
            }
        }
        assert!(lagged, "queue overflow must produce a lagged gap");
        assert!(events.len() < 10);
        assert!(events.windows(2).all(|pair| pair[0] < pair[1]));
        watch.close().await;
    }

    #[tokio::test]
    async fn flapping_server_cannot_grow_the_queue_without_bound() {
        // Every connection says hello and then closes. The consumer does not read for a while.
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let _ = socket.close(None).await;
        })
        .await;
        let tuning = Tuning {
            queue_capacity: 4,
            ..fast_tuning()
        };
        let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), tuning)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let queued = watch.session.shared.lock().queue.len();
        assert!(queued <= 4, "queue holds {queued} items");

        // Reconnects keep going while we drain, so only the first few items are inspected.
        let mut items = Vec::new();
        for _ in 0..4 {
            match timeout(Duration::from_millis(200), watch.next()).await {
                Ok(item) => items.push(item),
                Err(_) => break,
            }
        }
        assert!(
            items
                .iter()
                .any(|item| matches!(item, WatchItem::Gap { reason, .. } if reason == LAGGED))
        );
        watch.close().await;
    }

    // ----- ChatSession ---------------------------------------------------------------------

    fn created(event: &ClientEvent) -> ServerEvent {
        ServerEvent::MessageCreated {
            client_id: Some(client_id_of(event)),
            message: message("m-created", &body_of(event)),
        }
    }

    async fn start_session(server: &ServerUrl, tuning: Tuning) -> ChatSession {
        timeout(
            WAIT,
            ChatSession::start_with(server, ConnectOptions::default(), tuning),
        )
        .await
        .expect("session start timed out")
        .expect("session start failed")
    }

    /// Next item, including `Connecting`.
    async fn next_session_raw(session: &mut ChatSession) -> WatchItem {
        timeout(WAIT, session.next())
            .await
            .expect("timed out waiting for a session item")
    }

    /// Next item, skipping `Connecting`, for tests that do not look at reconnect attempts.
    async fn next_session(session: &mut ChatSession) -> WatchItem {
        loop {
            match next_session_raw(session).await {
                WatchItem::Connecting { .. } => continue,
                item => return item,
            }
        }
    }

    #[tokio::test]
    async fn session_confirms_send_and_streams_the_created_event() {
        let server = serve_chat(new_seen(), |event| vec![ack(event)]).await;
        let mut session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        match sender.send("c-1", "hello", false, WAIT).await {
            SendOutcome::Confirmed { client_id, message } => {
                assert_eq!(client_id, "c-1");
                assert_eq!(message.body, "hello");
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
        match next_session(&mut session).await {
            WatchItem::Connected {
                generation: 1,
                users,
                ..
            } => {
                assert_eq!(users.len(), 1);
                assert_eq!(users[0].login_name, "alice@test");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        // The confirmation is also an ordinary event, with its client_id still attached.
        match next_session(&mut session).await {
            WatchItem::Event {
                generation: 1,
                event:
                    ServerEvent::MessageCreated {
                        client_id: Some(id),
                        message,
                    },
            } => {
                assert_eq!(id, "c-1");
                assert_eq!(message.body, "hello");
            }
            other => panic!("unexpected item: {other:?}"),
        }
        session.close().await;
    }

    #[tokio::test]
    async fn session_send_while_reconnecting_is_not_sent_and_writes_nothing() {
        let seen = new_seen();
        let server = {
            let seen = seen.clone();
            serve(move |index, stream| {
                let seen = seen.clone();
                async move {
                    let Ok(mut socket) = accept_async(stream).await else {
                        return;
                    };
                    let _ = socket.send(json(&hello())).await;
                    if index == 0 {
                        let _ = socket.close(None).await;
                        return;
                    }
                    while let Some(event) = read_client(&mut socket).await {
                        seen.lock().unwrap().push(event.clone());
                        let _ = socket.send(json(&created(&event))).await;
                    }
                }
            })
            .await
        };
        let tuning = Tuning {
            backoff_min: Duration::from_millis(400),
            backoff_max: Duration::from_millis(400),
            ..Tuning::DEFAULT
        };
        let mut session = start_session(&server, tuning).await;
        let sender = session.sender();
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        // The session is backing off now: the send is refused and nothing reaches the server.
        assert!(matches!(
            sender.send("c-offline", "x", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
        assert!(seen.lock().unwrap().is_empty());

        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Connected { generation: 2, .. }
        ));
        assert!(matches!(
            sender.send("c-online", "y", false, WAIT).await,
            SendOutcome::Confirmed { .. }
        ));
        assert_eq!(sent_ids(&seen), vec!["c-online".to_owned()]);
        session.close().await;
    }

    #[tokio::test]
    async fn session_disconnect_before_ack_is_unknown_and_never_resent() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| match body_of(event).as_str() {
            "drop" => vec![Step::Close],
            _ => vec![ack(event)],
        })
        .await;
        let mut session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        assert!(matches!(
            sender.send("c-drop", "drop", false, WAIT).await,
            SendOutcome::Unknown {
                reason: UnknownReason::Disconnected,
                ..
            }
        ));
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Connected { generation: 2, .. }
        ));
        // Give the new connection time to receive anything that would be a resend.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(sent_ids(&seen), vec!["c-drop".to_owned()]);
        session.close().await;
    }

    #[tokio::test]
    async fn session_settles_concurrent_sends_independently() {
        // One error for another client arrives first, then both sends are answered in reverse.
        let server = serve(|_, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let mut got = Vec::new();
            while got.len() < 2 {
                match read_client(&mut socket).await {
                    Some(event) => got.push(event),
                    None => return,
                }
            }
            let _ = socket
                .send(json(&ServerEvent::Error {
                    client_id: Some("someone-else".into()),
                    code: "body_too_long".into(),
                    message: "not yours".into(),
                }))
                .await;
            for event in got.iter().rev() {
                let _ = socket.send(json(&created(event))).await;
            }
            let _ = read_frame(&mut socket).await;
        })
        .await;
        let session = start_session(&server, fast_tuning()).await;
        let a = session.sender();
        let b = a.clone();
        let (ra, rb) = tokio::join!(
            a.send("c-a", "from a", false, WAIT),
            b.send("c-b", "from b", false, WAIT)
        );
        match ra {
            SendOutcome::Confirmed { client_id, message } => {
                assert_eq!(client_id, "c-a");
                assert_eq!(message.body, "from a");
            }
            other => panic!("unexpected outcome for a: {other:?}"),
        }
        match rb {
            SendOutcome::Confirmed { client_id, message } => {
                assert_eq!(client_id, "c-b");
                assert_eq!(message.body, "from b");
            }
            other => panic!("unexpected outcome for b: {other:?}"),
        }
        session.close().await;
    }

    #[tokio::test]
    async fn session_refuses_duplicate_pending_id_and_times_out_unacked_sends() {
        let seen = new_seen();
        // Never acknowledges anything.
        let server = serve_chat(seen.clone(), |_| vec![]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        let first = {
            let sender = sender.clone();
            tokio::spawn(async move {
                sender
                    .send("c-1", "one", false, Duration::from_millis(300))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(matches!(
            sender.send("c-1", "again", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
        assert!(matches!(
            first.await.unwrap(),
            SendOutcome::Unknown {
                reason: UnknownReason::Timeout,
                ..
            }
        ));
        assert_eq!(sent_ids(&seen), vec!["c-1".to_owned()]);
        // An ack timeout does not end the session: the next send is still written.
        assert!(matches!(
            sender
                .send("c-2", "two", false, Duration::from_millis(100))
                .await,
            SendOutcome::Unknown {
                reason: UnknownReason::Timeout,
                ..
            }
        ));
        assert_eq!(sent_ids(&seen).len(), 2);
        session.close().await;
    }

    #[tokio::test]
    async fn closing_the_session_settles_pending_sends_and_later_sends_are_not_sent() {
        let server = serve_chat(new_seen(), |_| vec![]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        let pending = {
            let sender = sender.clone();
            tokio::spawn(async move { sender.send("c-open", "open", false, WAIT).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.close().await;
        assert!(matches!(
            pending.await.unwrap(),
            SendOutcome::Unknown {
                reason: UnknownReason::Disconnected,
                ..
            }
        ));
        assert!(matches!(
            sender.send("c-late", "late", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
    }

    #[tokio::test]
    async fn dropping_the_session_settles_pending_sends_as_unknown() {
        let server = serve_chat(new_seen(), |_| vec![]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        let pending = {
            let sender = sender.clone();
            tokio::spawn(async move { sender.send("c-drop-owner", "x", false, WAIT).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(session);
        assert!(matches!(
            pending.await.unwrap(),
            SendOutcome::Unknown {
                reason: UnknownReason::Disconnected,
                ..
            }
        ));
        assert!(matches!(
            sender.send("c-after", "x", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
    }

    #[tokio::test]
    async fn session_reports_terminal_failure_and_refuses_later_sends() {
        let server = serve(|index, stream| async move {
            if index == 0 {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let _ = socket.send(json(&hello())).await;
                let _ = socket.close(None).await;
            } else {
                let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                    Err(http::Response::builder()
                        .status(403)
                        .body(Some("forbidden".to_owned()))
                        .unwrap())
                };
                let _ = accept_hdr_async(stream, callback).await;
            }
        })
        .await;
        let mut session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        for _ in 0..2 {
            assert!(matches!(
                next_session(&mut session).await,
                WatchItem::Failed {
                    http_status: Some(403),
                    ..
                }
            ));
        }
        assert!(matches!(
            sender.send("c-dead", "x", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
        session.close().await;
    }

    fn outgoing_request(event: &ClientEvent) -> Option<SendRequest> {
        match event {
            ClientEvent::MessageSend {
                body,
                attachment_ids,
                reply_to,
                silent,
                ..
            } => Some(SendRequest {
                body: body.clone(),
                attachment_ids: attachment_ids.clone(),
                reply_to: reply_to.clone(),
                silent: *silent,
            }),
            _ => None,
        }
    }

    #[tokio::test]
    async fn send_request_puts_every_option_on_the_wire() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();

        let reply = SendRequest {
            body: "a reply".into(),
            reply_to: Some("m-parent".into()),
            silent: true,
            ..SendRequest::default()
        };
        assert!(matches!(
            sender.send_request("c-reply", reply.clone(), WAIT).await,
            SendOutcome::Confirmed { .. }
        ));
        // An attachment-only message is valid; the body may be empty.
        let attachments = SendRequest {
            attachment_ids: vec!["f-1".into(), "f-2".into()],
            ..SendRequest::default()
        };
        assert!(matches!(
            sender
                .send_request("c-files", attachments.clone(), WAIT)
                .await,
            SendOutcome::Confirmed { .. }
        ));

        let sent: Vec<SendRequest> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(outgoing_request)
            .collect();
        assert_eq!(sent, vec![reply, attachments]);
        session.close().await;
    }

    #[tokio::test]
    async fn send_request_refuses_empty_content_and_empty_ids_without_writing() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        let refused = [
            SendRequest::default(),
            SendRequest {
                body: "  ".into(),
                ..SendRequest::default()
            },
            SendRequest {
                body: "x".into(),
                reply_to: Some(String::new()),
                ..SendRequest::default()
            },
            SendRequest {
                body: "x".into(),
                attachment_ids: vec!["f".into(), String::new()],
                ..SendRequest::default()
            },
        ];
        for request in refused {
            assert!(matches!(
                sender.send_request("c-bad", request, WAIT).await,
                SendOutcome::NotSent { .. }
            ));
        }
        assert!(seen.lock().unwrap().is_empty());
        session.close().await;
    }

    #[tokio::test]
    async fn each_allowlisted_code_is_rejected_and_other_codes_are_unknown() {
        // The body names the error code the server answers with.
        let server = serve_chat(new_seen(), |event| {
            vec![error_for(Some(client_id_of(event)), &body_of(event))]
        })
        .await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        for code in REJECTED_CODES {
            match sender.send("c-code", code, false, WAIT).await {
                SendOutcome::Rejected { code: got, .. } => assert_eq!(got, code),
                other => panic!("{code} should be Rejected: {other:?}"),
            }
        }
        match sender.send("c-other", "internal", false, WAIT).await {
            SendOutcome::Unknown {
                reason: UnknownReason::ServerError { code, .. },
                ..
            } => assert_eq!(code, "internal"),
            other => panic!("unexpected outcome: {other:?}"),
        }
        session.close().await;
    }

    #[tokio::test]
    async fn emit_writes_the_event_and_refuses_message_send() {
        let seen = new_seen();
        let server = serve_chat(seen.clone(), |_| vec![]).await;
        let session = start_session(&server, fast_tuning()).await;
        let sender = session.sender();
        assert_eq!(
            sender
                .emit(ClientEvent::ReactionAdd {
                    message_id: "m-1".into(),
                    emoji: "+1".into(),
                })
                .await,
            Ok(())
        );
        assert_eq!(
            sender
                .emit(ClientEvent::MessageSend {
                    client_id: "c-x".into(),
                    body: "sneaky".into(),
                    attachment_ids: Vec::new(),
                    reply_to: None,
                    silent: false,
                })
                .await,
            Err(EmitError::SendNotAllowed)
        );
        // Let the server read the frame before checking what it received.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let events = seen.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            ClientEvent::ReactionAdd { message_id, .. } if message_id == "m-1"
        ));
        session.close().await;
    }

    #[tokio::test]
    async fn emit_and_send_while_reconnecting_are_refused_without_writing() {
        let seen = new_seen();
        let server = {
            let seen = seen.clone();
            serve(move |index, stream| {
                let seen = seen.clone();
                async move {
                    let Ok(mut socket) = accept_async(stream).await else {
                        return;
                    };
                    let _ = socket.send(json(&hello())).await;
                    if index == 0 {
                        let _ = socket.close(None).await;
                        return;
                    }
                    while let Some(event) = read_client(&mut socket).await {
                        seen.lock().unwrap().push(event);
                    }
                }
            })
            .await
        };
        let tuning = Tuning {
            backoff_min: Duration::from_millis(400),
            backoff_max: Duration::from_millis(400),
            ..Tuning::DEFAULT
        };
        let mut session = start_session(&server, tuning).await;
        let sender = session.sender();
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        assert_eq!(
            sender
                .emit(ClientEvent::ReactionRemove {
                    message_id: "m-1".into(),
                    emoji: "+1".into(),
                })
                .await,
            Err(EmitError::NotConnected)
        );
        assert!(matches!(
            sender.send("c-off", "x", false, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(seen.lock().unwrap().is_empty());
        session.close().await;
    }

    #[tokio::test]
    async fn reconnect_now_is_ignored_while_connected_and_wakes_a_backoff() {
        // Connection 0 drops at once, connection 1 drops after 200 ms, later ones stay open.
        let server = serve(|index, stream| async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            match index {
                0 => {
                    let _ = socket.close(None).await;
                }
                1 => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let _ = socket.close(None).await;
                }
                _ => {
                    let _ = read_frame(&mut socket).await;
                }
            }
        })
        .await;
        // A 2 s backoff (jittered to 1-2 s) so the two checks below can tell the two cases apart.
        let tuning = Tuning {
            backoff_min: Duration::from_secs(2),
            backoff_max: Duration::from_secs(2),
            ..Tuning::DEFAULT
        };
        let mut session = start_session(&server, tuning).await;
        // Called while connected, before the drop is seen: must not shorten the backoff.
        session.reconnect_now();
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Connected { generation: 1, .. }
        ));
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Gap { generation: 1, .. }
        ));
        let backoff_started = tokio::time::Instant::now();
        assert!(matches!(
            timeout(Duration::from_secs(5), session.next()).await,
            Ok(WatchItem::Connecting { attempt: 1 })
        ));
        assert!(
            backoff_started.elapsed() >= Duration::from_millis(900),
            "the early reconnect_now must not have skipped the backoff"
        );
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Connected { generation: 2, .. }
        ));
        assert!(matches!(
            next_session_raw(&mut session).await,
            WatchItem::Gap { generation: 2, .. }
        ));
        // Now the backoff is running again. reconnect_now must end it at once.
        let woken_at = tokio::time::Instant::now();
        session.reconnect_now();
        match timeout(Duration::from_millis(800), session.next()).await {
            Ok(WatchItem::Connecting { attempt: 1 }) => {}
            other => panic!("reconnect_now did not wake the backoff: {other:?}"),
        }
        assert!(matches!(
            timeout(Duration::from_secs(1), session.next()).await,
            Ok(WatchItem::Connected { generation: 3, .. })
        ));
        assert!(woken_at.elapsed() < Duration::from_secs(1));
        session.close().await;
    }
}
