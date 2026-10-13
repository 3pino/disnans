//! チャット WebSocket の Rust 経路（段4）。契約は `.pi/step4-ipc-contract.md` の §8。
//!
//! 本体の [`ChatHub`] は Tauri に依存しない（項目の送り先は [`ItemSink`] で受ける）。
//! Tauri の `Channel` は `ItemSink` を実装して渡す。接続は1本だけ持ち、`start` で置き換える。
//!
//! - 受信: 背景タスク（pump）が `ChatSession::next()` を順に読み、`ItemSink` へ同じ順序で渡す。
//! - 送信: `SessionSender::send_request` の結果をそのまま返す。自動で再送しない。
//! - 停止: 制御チャンネルを閉じると pump が `ChatSession::close()` を呼び、終わるまで待つ。
//!   `start` の二重呼び出しは先のセッションを止めてから始める。終了時は [`ChatHub::stop`] を呼ぶ。

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::task::Poll;
use std::time::Duration;

use disnans_client_core::{
    ChatSession, ConnectOptions, Message, ReadFailure, SendOutcome, SendRequest, ServerEvent,
    ServerUrl, SessionSender, UnknownReason, User, WatchItem, WsError,
};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::{self, JoinHandle, Mutex, Receiver, Sender};
use tauri::ipc::{Channel, JavaScriptChannelId};
use tauri::{State, Webview};

/// 送信の確認を待つ上限（CLI の `send` と同じ 15 秒）。TS からは指定しない。
pub const ACK_TIMEOUT: Duration = Duration::from_secs(15);

const NOT_CONNECTED: &str = "チャットに接続していないため送信しませんでした";

/// 項目の送り先。Tauri では `Channel<ChatItem>` を包んで実装する。
/// 送れなかった（相手が閉じた）ときは `false` を返す。
pub trait ItemSink: Send + 'static {
    fn deliver(&self, item: ChatItem) -> bool;
}

impl ItemSink for Channel<ChatItem> {
    fn deliver(&self, item: ChatItem) -> bool {
        self.send(item).is_ok()
    }
}

/// `chat_start` の Channel で流す項目（契約 §8.4）。
// 中身は wire の型そのもの（Message / ServerEvent）なので、サイズの差は受け入れる（core と同じ）
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatItem {
    Connecting {
        attempt: u32,
    },
    Connected {
        generation: u64,
        me: User,
        users: Vec<User>,
    },
    Event {
        generation: u64,
        event: ServerEvent,
    },
    Gap {
        generation: u64,
        reason: String,
    },
    Failed {
        reason: String,
        http_status: Option<u16>,
    },
}

impl From<WatchItem> for ChatItem {
    fn from(item: WatchItem) -> Self {
        match item {
            WatchItem::Connecting { attempt } => Self::Connecting { attempt },
            WatchItem::Connected {
                generation,
                me,
                users,
            } => Self::Connected {
                generation,
                me,
                users,
            },
            WatchItem::Event { generation, event } => Self::Event { generation, event },
            WatchItem::Gap { generation, reason } => Self::Gap { generation, reason },
            WatchItem::Failed {
                reason,
                http_status,
            } => Self::Failed {
                reason,
                http_status,
            },
        }
    }
}

/// `chat_send` の引数（契約 §8.5）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDraft {
    pub client_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub body: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub start_thread: bool,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub silent: bool,
}

impl MessageDraft {
    /// 書き込む前に確かめる引数。空の ID は null にすべきなので拒否する。
    /// 本文の空や長さは `SendRequest` の検証（`notSent`）に任せる。
    fn into_request(self) -> Result<(String, SendRequest), ReadFailure> {
        if self.client_id.trim().is_empty() {
            return Err(ReadFailure::invalid_request("clientId が空です"));
        }
        let empty_id = self.thread_id.as_deref() == Some("")
            || self.reply_to.as_deref() == Some("")
            || self.attachment_ids.iter().any(String::is_empty);
        if empty_id {
            return Err(ReadFailure::invalid_request(
                "ID が空文字です（なければ null にしてください）",
            ));
        }
        let request = SendRequest {
            thread_id: self.thread_id,
            body: self.body,
            attachment_ids: self.attachment_ids,
            start_thread: self.start_thread,
            reply_to: self.reply_to,
            silent: self.silent,
        };
        Ok((self.client_id, request))
    }
}

/// `chat_send` の戻り値（契約 §8.5）。
// 中身は wire の型そのもの（Message / ServerEvent）なので、サイズの差は受け入れる（core と同じ）
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SendResult {
    Confirmed {
        client_id: String,
        message: Message,
    },
    Rejected {
        client_id: String,
        code: String,
        message: String,
    },
    Unknown {
        client_id: String,
        reason: UnknownDto,
    },
    NotSent {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UnknownDto {
    Disconnected,
    Timeout,
    WriteFailed,
    ServerError { code: String, message: String },
}

impl From<SendOutcome> for SendResult {
    fn from(outcome: SendOutcome) -> Self {
        match outcome {
            SendOutcome::Confirmed { client_id, message } => Self::Confirmed { client_id, message },
            SendOutcome::Rejected {
                client_id,
                code,
                message,
            } => Self::Rejected {
                client_id,
                code,
                message,
            },
            SendOutcome::Unknown { client_id, reason } => Self::Unknown {
                client_id,
                reason: reason.into(),
            },
            SendOutcome::NotSent { reason } => Self::NotSent { reason },
        }
    }
}

impl From<UnknownReason> for UnknownDto {
    fn from(reason: UnknownReason) -> Self {
        match reason {
            UnknownReason::Disconnected => Self::Disconnected,
            UnknownReason::Timeout => Self::Timeout,
            UnknownReason::WriteFailed => Self::WriteFailed,
            UnknownReason::ServerError { code, message } => Self::ServerError { code, message },
        }
    }
}

/// 接続の失敗を `ApiBridgeError` の形にする（契約 §5）。接続前なので投稿の有無は関係ない。
fn connect_failure(err: WsError) -> ReadFailure {
    match err {
        WsError::InvalidUrl(_) => ReadFailure::invalid_request("サーバー URL が不正です"),
        WsError::InvalidDevUser => ReadFailure::invalid_request("開発用ユーザーIDが不正です"),
        WsError::Connect(_) => ReadFailure {
            status: None,
            code: "network".into(),
            message: "ネットワークエラー".into(),
        },
        WsError::Timeout => ReadFailure {
            status: None,
            code: "timeout".into(),
            message: "応答がありませんでした".into(),
        },
        WsError::Protocol(_) => ReadFailure {
            status: None,
            code: "bad_response".into(),
            message: "サーバーの応答を読めませんでした".into(),
        },
        WsError::Http { status } => ReadFailure {
            status: Some(status),
            code: format!("http_{status}"),
            message: tauri::http::StatusCode::from_u16(status)
                .ok()
                .and_then(|s| s.canonical_reason())
                .unwrap_or("HTTP error")
                .to_owned(),
        },
    }
}

/// 開発用ユーザーは表示可能な ASCII だけ（core と同じ規則）。接続を止める前に確かめる。
fn check_dev_user(user: Option<&str>) -> Result<(), ReadFailure> {
    match user {
        Some(user)
            if user.trim().is_empty() || !user.bytes().all(|b| (0x20..=0x7e).contains(&b)) =>
        {
            Err(ReadFailure::invalid_request("開発用ユーザーIDが不正です"))
        }
        _ => Ok(()),
    }
}

// 中身は wire の型そのもの（Message / ServerEvent）なので、サイズの差は受け入れる（core と同じ）
/// 背景タスクの停止・再接続の要求（制御チャンネル）。
#[allow(clippy::large_enum_variant)]
enum Step {
    /// `Some(())` は再接続、`None` は停止（送り手がいなくなった）。
    Control(Option<()>),
    Item(WatchItem),
}

/// 受信を順に `sink` へ流す。停止・送り先の消滅・終端（`Failed`）で `close()` して終わる。
/// 終わるときは、自分が起動中のセッションなら `active` を片付ける（古い状態を残さない）。
async fn pump<S: ItemSink>(
    mut session: ChatSession,
    mut control: Receiver<()>,
    sink: S,
    state: Arc<StdMutex<HubState>>,
    id: u64,
) {
    loop {
        let step = {
            // `next()` は取消安全なので、制御が先に来たら捨てて作り直す
            let mut next = pin!(session.next());
            poll_fn(|cx| {
                if let Poll::Ready(signal) = control.poll_recv(cx) {
                    return Poll::Ready(Step::Control(signal));
                }
                next.as_mut().poll(cx).map(Step::Item)
            })
            .await
        };
        match step {
            Step::Control(Some(())) => session.reconnect_now(),
            Step::Control(None) => break,
            Step::Item(item) => {
                let terminal = matches!(item, WatchItem::Failed { .. });
                if !sink.deliver(ChatItem::from(item)) || terminal {
                    break;
                }
            }
        }
    }
    session.close().await;
    let mut guard = state.lock().unwrap();
    if guard.active.as_ref().is_some_and(|a| a.id == id) {
        guard.active = None;
    }
}

/// 起動中のセッション（1 つだけ）。
struct Active {
    id: u64,
    sender: SessionSender,
    /// 送り手を閉じると pump が止まる。再接続の合図もここから送る。
    control: Sender<()>,
    pump: JoinHandle<()>,
}

/// `ChatHub` の共有状態。pump も終わるときに `active` を片付けるため参照する。
#[derive(Default)]
struct HubState {
    /// 終了中（Exit）。以後の `start` は接続しない。
    closing: bool,
    /// 接続の準備中に、それを中止する手段（準備中だけ入る）。
    connecting: Option<Box<dyn FnOnce() + Send>>,
    /// 起動中のセッション。
    active: Option<Active>,
    /// `Active` に振る番号（pump が自分のセッションかを確かめる）。
    next_id: u64,
}

/// 接続の途中で止められた（停止・終了）。接続は確立していない。
fn cancelled() -> ReadFailure {
    ReadFailure {
        status: None,
        code: "cancelled".into(),
        message: "接続を中止しました".into(),
    }
}

/// チャット接続の持ち主。Tauri の state として 1 つだけ置く。
#[derive(Default)]
pub struct ChatHub {
    /// 開始と停止を直列にする（接続の待ち時間の間も保持する）。
    lifecycle: Mutex<()>,
    /// 送信・再接続・pump が参照する。短時間だけ保持し、await をまたがない。
    state: Arc<StdMutex<HubState>>,
}

impl ChatHub {
    /// 接続を始める。最初の接続が成功するまで返らない。既存のセッションは先に止める。
    /// 失敗・中止したときはセッションが残らない（以後の送信は `notSent`）。
    pub async fn start<S: ItemSink>(
        &self,
        server: &str,
        dev_user: Option<String>,
        sink: S,
    ) -> Result<(), ReadFailure> {
        let _guard = self.lifecycle.lock().await;
        let url = ServerUrl::parse(server)
            .map_err(|_| ReadFailure::invalid_request("サーバー URL が不正です"))?;
        check_dev_user(dev_user.as_deref())?;
        self.stop_locked().await;
        if self.state.lock().unwrap().closing {
            return Err(cancelled());
        }
        let opts = ConnectOptions {
            dev_user,
            ..ConnectOptions::default()
        };
        // 接続は別タスクで行い、停止・終了のときは止められるようにする
        let connect = async_runtime::spawn(async move { ChatSession::start(&url, opts).await });
        let abort = connect.inner().abort_handle();
        self.state.lock().unwrap().connecting = Some(Box::new(move || abort.abort()));
        let joined = connect.await;
        self.state.lock().unwrap().connecting = None;
        let session = match joined {
            Ok(Ok(session)) => session,
            Ok(Err(err)) => return Err(connect_failure(err)),
            Err(_) => return Err(cancelled()),
        };

        let sender = session.sender();
        let (control, control_rx) = async_runtime::channel(8);
        let mut state = self.state.lock().unwrap();
        if state.closing {
            // 接続している間に終了が始まった。このセッションは使わない
            return Err(cancelled());
        }
        state.next_id += 1;
        let id = state.next_id;
        let pump = async_runtime::spawn(pump(session, control_rx, sink, self.state.clone(), id));
        state.active = Some(Active {
            id,
            sender,
            control,
            pump,
        });
        Ok(())
    }

    /// 送信する。セッションが無い・止まっているときは `notSent`（書き込まない）。
    /// 引数が不正なときだけ `Err`。自動で再送しない。
    pub async fn send(&self, draft: MessageDraft) -> Result<SendResult, ReadFailure> {
        let (client_id, request) = draft.into_request()?;
        let sender = self
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(|a| a.sender.clone());
        let Some(sender) = sender else {
            return Ok(SendResult::NotSent {
                reason: NOT_CONNECTED.into(),
            });
        };
        let outcome = sender.send_request(&client_id, request, ACK_TIMEOUT).await;
        Ok(outcome.into())
    }

    /// 切断中なら待機を終えて即再接続する。接続中・無いときは何もしない。
    pub fn reconnect(&self) {
        if let Some(active) = self.state.lock().unwrap().active.as_ref() {
            // 満杯なら既に再接続の要求が残っているので、捨ててよい
            let _ = active.control.try_send(());
        }
    }

    /// 接続を止め、背景タスクが終わるまで待つ。保留中の送信は `unknown` になる。
    /// 接続の準備中なら、それを中止してから待つ（準備中の `start` は中止で失敗する）。
    pub async fn stop(&self) {
        let connecting = self.state.lock().unwrap().connecting.take();
        if let Some(abort) = connecting {
            abort();
        }
        let _guard = self.lifecycle.lock().await;
        self.stop_locked().await;
    }

    /// 終了時に使う。待たずに、準備中の接続とセッションを中止する。
    /// 以後の `start` は接続しない。プロセス終了で接続は閉じられる（終了の close フレームは送らない）。
    pub fn shutdown_now(&self) {
        let (connecting, active) = {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            (state.connecting.take(), state.active.take())
        };
        if let Some(abort) = connecting {
            abort();
        }
        if let Some(active) = active {
            active.pump.abort();
        }
    }

    async fn stop_locked(&self) {
        let taken = self.state.lock().unwrap().active.take();
        if let Some(Active {
            sender,
            control,
            pump,
            ..
        }) = taken
        {
            drop(sender);
            drop(control);
            let _ = pump.await;
        }
    }

    #[cfg(test)]
    fn has_active(&self) -> bool {
        self.state.lock().unwrap().active.is_some()
    }

    #[cfg(test)]
    fn is_connecting(&self) -> bool {
        self.state.lock().unwrap().connecting.is_some()
    }
}

/// `start` の引数（契約 §8.3）。`onItem` は Tauri の Channel。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    /// フロントの Channel。Tauri の Channel は引数の直下にしか置けないため、ID を受けて後で Channel にする。
    pub on_item: JavaScriptChannelId,
}

#[tauri::command]
pub async fn chat_start(
    args: StartArgs,
    webview: Webview,
    hub: State<'_, ChatHub>,
) -> Result<(), ReadFailure> {
    let sink: Channel<ChatItem> = args.on_item.channel_on(webview);
    hub.start(&args.server, args.dev_user, sink).await
}

#[tauri::command]
pub async fn chat_send(
    draft: MessageDraft,
    hub: State<'_, ChatHub>,
) -> Result<SendResult, ReadFailure> {
    hub.send(draft).await
}

#[tauri::command]
pub fn chat_reconnect(hub: State<'_, ChatHub>) {
    hub.reconnect();
}

#[tauri::command]
pub async fn chat_stop(hub: State<'_, ChatHub>) -> Result<(), ReadFailure> {
    hub.stop().await;
    Ok(())
}

#[cfg(test)]
#[path = "chat_bridge_tests.rs"]
mod server_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(client_id: &str) -> MessageDraft {
        MessageDraft {
            client_id: client_id.into(),
            thread_id: None,
            body: "hi".into(),
            attachment_ids: vec![],
            start_thread: false,
            reply_to: None,
            silent: false,
        }
    }

    #[test]
    fn empty_client_id_and_empty_ids_are_invalid_requests() {
        let err = draft("  ").into_request().unwrap_err();
        assert_eq!(err.code, "invalid_request");
        assert_eq!(err.status, None);

        let mut d = draft("c1");
        d.thread_id = Some(String::new());
        assert_eq!(d.into_request().unwrap_err().code, "invalid_request");

        let mut d = draft("c1");
        d.reply_to = Some(String::new());
        assert_eq!(d.into_request().unwrap_err().code, "invalid_request");

        let mut d = draft("c1");
        d.attachment_ids = vec!["ok".into(), String::new()];
        assert_eq!(d.into_request().unwrap_err().code, "invalid_request");
    }

    #[test]
    fn valid_draft_maps_every_field_to_send_request() {
        let mut d = draft("c1");
        d.thread_id = Some("t1".into());
        d.attachment_ids = vec!["a1".into()];
        d.start_thread = true;
        d.reply_to = Some("m1".into());
        d.silent = true;
        let (client_id, request) = d.into_request().unwrap();
        assert_eq!(client_id, "c1");
        assert_eq!(request.thread_id.as_deref(), Some("t1"));
        assert_eq!(request.body, "hi");
        assert_eq!(request.attachment_ids, vec!["a1".to_string()]);
        assert!(request.start_thread);
        assert_eq!(request.reply_to.as_deref(), Some("m1"));
        assert!(request.silent);
    }

    #[test]
    fn draft_json_is_camel_case_and_rejects_unknown_fields() {
        let ok: MessageDraft = serde_json::from_value(serde_json::json!({
            "clientId": "c1", "threadId": null, "body": "x", "attachmentIds": [],
            "startThread": false, "replyTo": null, "silent": true
        }))
        .unwrap();
        assert!(ok.silent);

        let bad = serde_json::from_value::<MessageDraft>(serde_json::json!({
            "clientId": "c1", "body": "x", "unknown": 1
        }));
        assert!(bad.is_err());
    }

    #[test]
    fn dev_user_rule_matches_core() {
        assert!(check_dev_user(None).is_ok());
        assert!(check_dev_user(Some("alice")).is_ok());
        assert!(check_dev_user(Some("  ")).is_err());
        assert!(check_dev_user(Some("ありす")).is_err());
        assert!(check_dev_user(Some("a\nb")).is_err());
    }

    #[test]
    fn connect_failures_keep_status_code_and_message() {
        let f = connect_failure(WsError::Http { status: 401 });
        assert_eq!(f.status, Some(401));
        assert_eq!(f.code, "http_401");
        assert_eq!(f.message, "Unauthorized");

        let f = connect_failure(WsError::Connect("refused".into()));
        assert_eq!((f.status, f.code.as_str()), (None, "network"));

        let f = connect_failure(WsError::Timeout);
        assert_eq!(f.code, "timeout");

        let f = connect_failure(WsError::Protocol("x".into()));
        assert_eq!(f.code, "bad_response");

        let f = connect_failure(WsError::InvalidUrl("x".into()));
        assert_eq!(f.code, "invalid_request");
    }

    #[test]
    fn send_outcomes_map_to_the_contract_shapes() {
        let v = |r: SendResult| serde_json::to_value(r).unwrap();

        let v1 = v(SendOutcome::NotSent { reason: "x".into() }.into());
        assert_eq!(v1, serde_json::json!({"outcome": "notSent", "reason": "x"}));

        let v2 = v(SendOutcome::Rejected {
            client_id: "c1".into(),
            code: "empty_message".into(),
            message: "m".into(),
        }
        .into());
        assert_eq!(
            v2,
            serde_json::json!({"outcome": "rejected", "clientId": "c1", "code": "empty_message", "message": "m"})
        );

        let v3 = v(SendOutcome::Unknown {
            client_id: "c2".into(),
            reason: UnknownReason::Disconnected,
        }
        .into());
        assert_eq!(
            v3,
            serde_json::json!({"outcome": "unknown", "clientId": "c2", "reason": {"kind": "disconnected"}})
        );

        let v4 = v(SendOutcome::Unknown {
            client_id: "c3".into(),
            reason: UnknownReason::ServerError {
                code: "internal".into(),
                message: "m".into(),
            },
        }
        .into());
        assert_eq!(
            v4,
            serde_json::json!({"outcome": "unknown", "clientId": "c3", "reason": {"kind": "serverError", "code": "internal", "message": "m"}})
        );
    }

    #[test]
    fn watch_items_map_to_the_contract_kinds() {
        let v = |i: WatchItem| serde_json::to_value(ChatItem::from(i)).unwrap();
        assert_eq!(
            v(WatchItem::Connecting { attempt: 2 }),
            serde_json::json!({"kind": "connecting", "attempt": 2})
        );
        assert_eq!(
            v(WatchItem::Gap {
                generation: 3,
                reason: "disconnected".into()
            }),
            serde_json::json!({"kind": "gap", "generation": 3, "reason": "disconnected"})
        );
        assert_eq!(
            v(WatchItem::Failed {
                reason: "401".into(),
                http_status: Some(401)
            }),
            serde_json::json!({"kind": "failed", "reason": "401", "httpStatus": 401})
        );
        assert_eq!(
            v(WatchItem::Failed {
                reason: "x".into(),
                http_status: None
            })["httpStatus"],
            serde_json::Value::Null
        );
    }
}
