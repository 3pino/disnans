//! `ChatHub` を fake WebSocket サーバーに対して動かすテスト（core の ws.rs テストと同じ方式）。
//!
//! 同期関数で書き、非同期の処理は `tauri::async_runtime::block_on` で待つ。背景タスク（pump・
//! fake サーバー）は Tauri のランタイム上で動くので、テスト側は `wait_until` で待つだけでよい。
//! 時間切れの待ちは core の `ChatSession` 側に任せ、テストは項目が届くまで（上限 10 秒）待つ。

#![allow(clippy::result_large_err, clippy::large_enum_variant)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use disnans_client_core::{Message, ServerEvent, User};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::async_runtime::{self, JoinHandle};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async,
    tungstenite::{
        Message as WsMessage,
        handshake::server::{ErrorResponse, Request, Response},
        http,
    },
};

use super::{
    ChatHub, ChatItem, ItemSink, MAX_AUDIO_IN_FLIGHT, MAX_CALL_PAYLOAD_BYTES, MessageDraft,
    SendResult, UnknownDto, take_audio_slot,
};

// ----- 送り先 ---------------------------------------------------------------------------------

/// 項目を溜めるだけの送り先。`accept` を false にすると拒否する（Channel が閉じた状態の再現）。
#[derive(Clone)]
struct Collect {
    items: Arc<StdMutex<Vec<ChatItem>>>,
    accept: Arc<AtomicBool>,
}

impl Collect {
    fn new() -> Self {
        Self {
            items: Arc::new(StdMutex::new(Vec::new())),
            accept: Arc::new(AtomicBool::new(true)),
        }
    }

    fn len(&self) -> usize {
        self.items.lock().unwrap().len()
    }

    fn items(&self) -> Vec<ChatItem> {
        self.items.lock().unwrap().clone()
    }

    /// pump が送り先を持つ数（テストの手元の 1 つを除く）。pump が終わると 0 になる。
    fn held_by_pump(&self) -> usize {
        Arc::strong_count(&self.items) - 1
    }
}

impl ItemSink for Collect {
    fn deliver(&self, item: ChatItem) -> bool {
        if !self.accept.load(Ordering::SeqCst) {
            return false;
        }
        self.items.lock().unwrap().push(item);
        true
    }
}

// ----- fake サーバー --------------------------------------------------------------------------

/// サーバーがクライアントの `message.send` に返す動作。
enum Step {
    Event(ServerEvent),
    /// 接続を閉じる（クライアントから見ると切断）。
    Close,
    /// 次の動作まで待つ（音声の流れを模す）。
    Wait(Duration),
}

/// (接続の番号, クライアントの送ったフレーム) → 返す動作。番号は接続ごとに 0 から。
type Reply = Arc<dyn Fn(usize, &Value) -> Vec<Step> + Send + Sync>;

#[derive(Default)]
struct Log {
    /// 受け取った `message.send` の client_id（受けた順）
    sends: Vec<String>,
    /// 受け取った全フレーム（JSON として読めたもの。種類は問わない）
    frames: Vec<Value>,
    /// 受けた WebSocket の接続要求ごとの `X-Dev-User`
    dev_users: Vec<Option<String>>,
    /// 終わった接続の数（拒否された要求も含む）
    ended: usize,
}

/// 127.0.0.1:0 で待ち受ける fake サーバー。Drop で待ち受けを止める（接続は閉じる）。
struct Fake {
    url: String,
    log: Arc<StdMutex<Log>>,
    /// true の間の接続要求は 401 で拒否する
    reject: Arc<AtomicBool>,
    _task: JoinHandle<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self._task.abort();
    }
}

impl Fake {
    fn start(reply: Reply) -> Self {
        async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let log = Arc::new(StdMutex::new(Log::default()));
            let reject = Arc::new(AtomicBool::new(false));
            let task = {
                let log = log.clone();
                let reject = reject.clone();
                async_runtime::spawn(async move {
                    let mut index = 0;
                    while let Ok((stream, _)) = listener.accept().await {
                        let refuse = reject.load(Ordering::SeqCst);
                        async_runtime::spawn(serve_connection(
                            index,
                            stream,
                            refuse,
                            reply.clone(),
                            log.clone(),
                        ));
                        index += 1;
                    }
                })
            };
            Self {
                url: format!("http://{address}"),
                log,
                reject,
                _task: task,
            }
        })
    }

    fn sends(&self) -> Vec<String> {
        self.log.lock().unwrap().sends.clone()
    }

    fn frames(&self) -> Vec<Value> {
        self.log.lock().unwrap().frames.clone()
    }

    fn dev_users(&self) -> Vec<Option<String>> {
        self.log.lock().unwrap().dev_users.clone()
    }

    fn ended(&self) -> usize {
        self.log.lock().unwrap().ended
    }

    fn set_reject(&self, refuse: bool) {
        self.reject.store(refuse, Ordering::SeqCst);
    }
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

/// 送られた `message.send` を確認する（自分の client_id で確定する）。
fn ack(value: &Value) -> Step {
    Step::Event(ServerEvent::MessageCreated {
        client_id: value["client_id"].as_str().map(str::to_owned),
        message: message("m-ack", value["body"].as_str().unwrap_or_default()),
    })
}

/// 別の接続や他者の投稿として届く（client_id なし）。
fn created(body: &str) -> Step {
    Step::Event(ServerEvent::MessageCreated {
        client_id: None,
        message: message(&format!("m-{body}"), body),
    })
}

fn error_for(value: &Value, code: &str) -> Step {
    Step::Event(ServerEvent::Error {
        client_id: value["client_id"].as_str().map(str::to_owned),
        code: code.into(),
        message: "test error".into(),
    })
}

async fn serve_connection(
    index: usize,
    stream: TcpStream,
    refuse: bool,
    reply: Reply,
    log: Arc<StdMutex<Log>>,
) {
    run_connection(index, stream, refuse, &reply, &log).await;
    log.lock().unwrap().ended += 1;
}

async fn run_connection(
    index: usize,
    stream: TcpStream,
    refuse: bool,
    reply: &Reply,
    log: &Arc<StdMutex<Log>>,
) {
    let callback_log = log.clone();
    let callback = move |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let dev_user = req
            .headers()
            .get("x-dev-user")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        callback_log.lock().unwrap().dev_users.push(dev_user);
        if refuse {
            Err(http::Response::builder()
                .status(401)
                .body(Some("denied".to_owned()))
                .unwrap())
        } else {
            Ok(response)
        }
    };
    let Ok(mut socket): Result<WebSocketStream<TcpStream>, _> =
        accept_hdr_async(stream, callback).await
    else {
        return;
    };
    if socket.send(json(&hello())).await.is_err() {
        return;
    }
    while let Some(Ok(frame)) = socket.next().await {
        match frame {
            WsMessage::Text(text) => {
                let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                log.lock().unwrap().frames.push(value.clone());
                if value["type"] != "message.send" {
                    continue;
                }
                log.lock()
                    .unwrap()
                    .sends
                    .push(value["client_id"].as_str().unwrap_or_default().to_owned());
                for step in reply(index, &value) {
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
                        Step::Wait(d) => tokio::time::sleep(d).await,
                    }
                }
            }
            WsMessage::Close(_) => return,
            _ => {}
        }
    }
}

fn echo_everything() -> Reply {
    Arc::new(|_: usize, value: &Value| vec![ack(value)])
}

// ----- テストの補助 ---------------------------------------------------------------------------

fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn draft(client_id: &str, body: &str) -> MessageDraft {
    MessageDraft {
        client_id: client_id.into(),
        body: body.into(),
        attachment_ids: vec![],
        reply_to: None,
        silent: false,
    }
}

/// 使われていないポートの URL（接続は拒否される）。
fn closed_port_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{address}")
}

fn start(
    hub: &ChatHub,
    url: &str,
    user: Option<&str>,
    sink: Collect,
) -> Result<(), super::ReadFailure> {
    async_runtime::block_on(hub.start(url, user.map(str::to_owned), sink))
}

fn send(hub: &ChatHub, draft: MessageDraft) -> SendResult {
    async_runtime::block_on(hub.send(draft)).unwrap()
}

fn created_bodies(items: &[ChatItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match item {
            ChatItem::Event {
                event: ServerEvent::MessageCreated { message, .. },
                ..
            } => Some(message.body.clone()),
            _ => None,
        })
        .collect()
}

fn has_echo(items: &[ChatItem], client_id: &str) -> bool {
    items.iter().any(|item| {
        matches!(item, ChatItem::Event {
            event: ServerEvent::MessageCreated { client_id: Some(id), .. },
            ..
        } if id.as_str() == client_id)
    })
}

fn connected_generation(items: &[ChatItem], generation: u64) -> bool {
    items
        .iter()
        .any(|item| matches!(item, ChatItem::Connected { generation: g, .. } if *g == generation))
}

fn has_gap(items: &[ChatItem]) -> bool {
    items
        .iter()
        .any(|item| matches!(item, ChatItem::Gap { .. }))
}

fn failed_http_status(items: &[ChatItem]) -> Option<Option<u16>> {
    items.iter().find_map(|item| match item {
        ChatItem::Failed { http_status, .. } => Some(*http_status),
        _ => None,
    })
}

// ----- テスト ---------------------------------------------------------------------------------

#[test]
fn connected_comes_first_and_the_own_send_is_confirmed_and_echoed() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();

    wait_until("connected", || sink.len() >= 1);
    assert!(matches!(
        sink.items()[0],
        ChatItem::Connected { generation: 1, .. }
    ));
    assert_eq!(fake.dev_users(), vec![Some("alice".to_string())]);

    match send(&hub, draft("c-own-1", "hello from rust")) {
        SendResult::Confirmed { client_id, message } => {
            assert_eq!(client_id, "c-own-1");
            assert_eq!(message.body, "hello from rust");
        }
        other => panic!("expected confirmed, got {other:?}"),
    }
    wait_until("echo", || has_echo(&sink.items(), "c-own-1"));
    assert_eq!(fake.sends(), vec!["c-own-1"]);

    async_runtime::block_on(hub.stop());
}

#[test]
fn events_arrive_in_the_order_the_server_sent_them() {
    let reply: Reply = Arc::new(|_: usize, value: &Value| {
        if value["body"] == "go" {
            vec![created("one"), created("two"), created("three"), ack(value)]
        } else {
            vec![ack(value)]
        }
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    assert!(matches!(
        send(&hub, draft("c-go", "go")),
        SendResult::Confirmed { .. }
    ));
    wait_until("all events", || created_bodies(&sink.items()).len() >= 4);
    assert_eq!(
        created_bodies(&sink.items()),
        vec!["one", "two", "three", "go"]
    );

    async_runtime::block_on(hub.stop());
}

#[test]
fn a_send_that_the_server_refuses_keeps_its_code_as_rejected() {
    let reply: Reply = Arc::new(|_: usize, value: &Value| {
        if value["body"] == "bad-reply" {
            vec![error_for(value, "reply_not_found")]
        } else {
            vec![ack(value)]
        }
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    match send(&hub, draft("c-refused", "bad-reply")) {
        SendResult::Rejected {
            client_id, code, ..
        } => {
            assert_eq!(client_id, "c-refused");
            assert_eq!(code, "reply_not_found");
        }
        other => panic!("expected rejected, got {other:?}"),
    }
    assert!(!has_echo(&sink.items(), "c-refused"));

    async_runtime::block_on(hub.stop());
}

#[test]
fn an_error_that_does_not_prove_refusal_is_unknown_and_not_resent() {
    let reply: Reply = Arc::new(|_: usize, value: &Value| {
        if value["body"] == "server-trouble" {
            vec![error_for(value, "internal")]
        } else {
            vec![ack(value)]
        }
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    match send(&hub, draft("c-unknown", "server-trouble")) {
        SendResult::Unknown { client_id, reason } => {
            assert_eq!(client_id, "c-unknown");
            let v = serde_json::to_value(reason).unwrap();
            assert_eq!(v["kind"], "serverError");
            assert_eq!(v["code"], "internal");
        }
        other => panic!("expected unknown, got {other:?}"),
    }
    // 同じ接続で続けて送れる。前の送信は再送されていない
    assert!(matches!(
        send(&hub, draft("c-next", "ok")),
        SendResult::Confirmed { .. }
    ));
    assert_eq!(fake.sends(), vec!["c-unknown", "c-next"]);

    async_runtime::block_on(hub.stop());
}

#[test]
fn disconnect_before_the_ack_is_unknown_and_the_send_is_never_resent() {
    // 1 本目の接続だけ、送信を受けたところで閉じる。2 本目以降は普通に応答する
    let reply: Reply = Arc::new(|index: usize, value: &Value| {
        if index == 0 {
            vec![Step::Close]
        } else {
            vec![ack(value)]
        }
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    match send(&hub, draft("c-lost", "maybe-saved")) {
        SendResult::Unknown { client_id, reason } => {
            assert_eq!(client_id, "c-lost");
            assert_eq!(
                serde_json::to_value(reason).unwrap()["kind"],
                "disconnected"
            );
        }
        other => panic!("expected unknown, got {other:?}"),
    }

    // 再接続（generation 2）を待つ。その後も client_id "c-lost" は一度も送られない
    wait_until("reconnected", || connected_generation(&sink.items(), 2));
    assert!(has_gap(&sink.items()), "a disconnect is reported as a gap");
    assert_eq!(
        fake.sends(),
        vec!["c-lost"],
        "the unknown send was not resent"
    );

    // 再接続後の送信は新しく通る
    assert!(matches!(
        send(&hub, draft("c-after", "ok")),
        SendResult::Confirmed { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn a_send_without_a_session_is_not_sent_and_bad_arguments_are_refused() {
    let hub = ChatHub::default();
    assert!(matches!(
        send(&hub, draft("c-none", "x")),
        SendResult::NotSent { .. }
    ));

    let err = async_runtime::block_on(hub.send(draft("", "x"))).unwrap_err();
    assert_eq!(err.code, "invalid_request");
    assert_eq!(err.status, None);
}

#[test]
fn an_empty_body_is_not_sent_and_the_connection_stays_usable() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    assert!(matches!(
        send(&hub, draft("c-empty", "   ")),
        SendResult::NotSent { .. }
    ));
    assert!(matches!(
        send(&hub, draft("c-after", "ok")),
        SendResult::Confirmed { .. }
    ));
    assert_eq!(
        fake.sends(),
        vec!["c-after"],
        "the empty body never reached the server"
    );

    async_runtime::block_on(hub.stop());
}

#[test]
fn failed_starts_leave_no_session_and_the_hub_can_start_again() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();

    let err = start(&hub, "not a url", None, sink.clone()).unwrap_err();
    assert_eq!(err.code, "invalid_request");

    let err = start(&hub, &fake.url, Some("ありす"), sink.clone()).unwrap_err();
    assert_eq!(err.code, "invalid_request");
    assert!(
        fake.dev_users().is_empty(),
        "invalid input does not reach the network"
    );

    let err = start(&hub, &closed_port_url(), Some("alice"), sink.clone()).unwrap_err();
    assert_eq!(err.code, "network");
    assert_eq!(err.status, None);

    fake.set_reject(true);
    let err = start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap_err();
    assert_eq!(err.status, Some(401));
    assert_eq!(err.code, "http_401");
    assert_eq!(err.message, "Unauthorized");
    fake.set_reject(false);

    assert_eq!(sink.len(), 0, "nothing is delivered when a start fails");
    assert!(matches!(
        send(&hub, draft("c-after-fail", "x")),
        SendResult::NotSent { .. }
    ));

    // 失敗の後でも同じ hub で始め直せる
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);
    assert!(matches!(
        send(&hub, draft("c-restart", "ok")),
        SendResult::Confirmed { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn after_a_terminal_failure_the_hub_can_start_again() {
    // 接続が切れたあと、再接続が 401 で拒否されると Failed で終わる。その後は同じ hub で始め直せる
    let reply: Reply = Arc::new(|_: usize, value: &Value| {
        if value["body"] == "drop" {
            vec![Step::Close]
        } else {
            vec![ack(value)]
        }
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    fake.set_reject(true);
    let _ = send(&hub, draft("c-drop", "drop"));
    wait_until("failed", || failed_http_status(&sink.items()).is_some());
    assert_eq!(failed_http_status(&sink.items()), Some(Some(401)));
    wait_until("failed session released its sink", || {
        sink.held_by_pump() == 0
    });
    assert!(
        !hub.has_active(),
        "the failed session is cleared from the hub"
    );
    assert!(matches!(
        send(&hub, draft("c-dead", "x")),
        SendResult::NotSent { .. }
    ));

    fake.set_reject(false);
    let sink2 = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink2.clone()).unwrap();
    wait_until("connected again", || sink2.len() >= 1);
    assert!(matches!(
        sink2.items()[0],
        ChatItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        send(&hub, draft("c-new", "ok")),
        SendResult::Confirmed { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn stop_ends_the_background_task_closes_the_connection_and_drops_the_sink() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);
    assert_eq!(
        sink.held_by_pump(),
        1,
        "the pump holds the sink while running"
    );
    let before = sink.len();

    async_runtime::block_on(hub.stop());
    // stop は pump が終わるまで待つので、この時点で送り先は手放されている
    assert_eq!(sink.held_by_pump(), 0, "pump ended and dropped the sink");
    wait_until("server saw the close", || fake.ended() >= 1);

    assert!(matches!(
        send(&hub, draft("c-stopped", "x")),
        SendResult::NotSent { .. }
    ));
    assert_eq!(sink.len(), before, "no item after stop");
}

#[test]
fn a_second_start_stops_the_first_session_before_the_new_one_is_used() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();

    let first = Collect::new();
    start(&hub, &fake.url, Some("alice"), first.clone()).unwrap();
    wait_until("first connected", || first.len() >= 1);

    let second = Collect::new();
    start(&hub, &fake.url, Some("alice"), second.clone()).unwrap();
    wait_until("second connected", || second.len() >= 1);
    assert_eq!(first.held_by_pump(), 0, "the first pump is gone");
    assert!(matches!(
        second.items()[0],
        ChatItem::Connected { generation: 1, .. }
    ));
    wait_until("first connection closed on the server", || {
        fake.ended() >= 1
    });

    assert!(matches!(
        send(&hub, draft("c-second", "via second")),
        SendResult::Confirmed { .. }
    ));
    wait_until("echo on second", || has_echo(&second.items(), "c-second"));
    assert!(
        !has_echo(&first.items(), "c-second"),
        "the old sink gets nothing new"
    );

    async_runtime::block_on(hub.stop());
}

#[test]
fn a_sink_that_refuses_items_ends_the_session() {
    let reply: Reply = Arc::new(|_: usize, value: &Value| vec![created("pushed"), ack(value)]);
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // 送り先が閉じた（Channel が破棄された）後に項目が来ると、pump は止まる
    sink.accept.store(false, Ordering::SeqCst);
    let _ = send(&hub, draft("c-trigger", "x"));
    wait_until("pump ended", || sink.held_by_pump() == 0);
    assert!(
        !hub.has_active(),
        "the finished session is cleared from the hub"
    );
    assert!(matches!(
        send(&hub, draft("c-dead", "x")),
        SendResult::NotSent { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn reconnect_while_connected_changes_nothing() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);
    let before = sink.len();

    hub.reconnect();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(sink.len(), before, "no new items while connected");
    assert!(matches!(
        send(&hub, draft("c-still", "ok")),
        SendResult::Confirmed { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn stop_without_a_session_is_harmless() {
    let hub = ChatHub::default();
    async_runtime::block_on(hub.stop());
    hub.reconnect();
    async_runtime::block_on(hub.stop());
}

#[test]
fn unknown_reasons_serialize_with_their_kind() {
    let v = serde_json::to_value(UnknownDto::Timeout).unwrap();
    assert_eq!(v["kind"], "timeout");
}

// ----- 停止・終了（接続の準備中を含む） -----------------------------------------------------

/// TCP は受け付けるが WebSocket の応答を返さない相手。接続の準備が終わらない状態を作る。
fn silent_server() -> (std::net::TcpListener, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// 別スレッドで `start` を待つ（準備中の状態を作るため）。
fn start_in_background(
    hub: &Arc<ChatHub>,
    url: &str,
    sink: Collect,
) -> std::thread::JoinHandle<Result<(), super::ReadFailure>> {
    let hub = hub.clone();
    let url = url.to_owned();
    std::thread::spawn(move || async_runtime::block_on(hub.start(&url, Some("alice".into()), sink)))
}

#[test]
fn shutdown_during_connect_returns_at_once_and_the_start_is_cancelled() {
    let (_silent, url) = silent_server();
    let hub = Arc::new(ChatHub::default());
    let sink = Collect::new();
    let worker = start_in_background(&hub, &url, sink.clone());
    wait_until("connecting", || hub.is_connecting());

    let began = Instant::now();
    hub.shutdown_now();
    assert!(
        began.elapsed() < Duration::from_secs(1),
        "shutdown must not wait for the connect"
    );

    wait_until("start returned", || worker.is_finished());
    let err = worker.join().unwrap().unwrap_err();
    assert_eq!(err.code, "cancelled");
    assert_eq!(err.status, None);
    assert!(!hub.is_connecting());
    assert!(!hub.has_active());
    assert_eq!(sink.len(), 0);

    // 終了のあとの start は接続しない（閉じたポートでも、ネットワークエラーではなく cancelled）
    let err = async_runtime::block_on(hub.start(
        &closed_port_url(),
        Some("alice".into()),
        Collect::new(),
    ))
    .unwrap_err();
    assert_eq!(err.code, "cancelled");
}

#[test]
fn stop_during_connect_cancels_the_start_and_the_hub_still_works_afterwards() {
    let (_silent, silent_url) = silent_server();
    let hub = Arc::new(ChatHub::default());
    let worker = start_in_background(&hub, &silent_url, Collect::new());
    wait_until("connecting", || hub.is_connecting());

    let began = Instant::now();
    async_runtime::block_on(hub.stop());
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "stop must not wait for the connect timeout"
    );
    wait_until("start returned", || worker.is_finished());
    assert_eq!(worker.join().unwrap().unwrap_err().code, "cancelled");

    // 停止は終了ではないので、同じ hub でそのまま接続できる
    let fake = Fake::start(echo_everything());
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);
    assert!(matches!(
        send(&hub, draft("c-after-stop", "ok")),
        SendResult::Confirmed { .. }
    ));

    async_runtime::block_on(hub.stop());
}

#[test]
fn shutdown_now_closes_a_live_session_and_refuses_later_starts() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    hub.shutdown_now();
    wait_until("pump dropped the sink", || sink.held_by_pump() == 0);
    wait_until("server saw the close", || fake.ended() >= 1);
    assert!(!hub.has_active());
    assert!(matches!(
        send(&hub, draft("c-x", "x")),
        SendResult::NotSent { .. }
    ));

    let err = start(&hub, &fake.url, Some("alice"), Collect::new()).unwrap_err();
    assert_eq!(err.code, "cancelled");
    assert_eq!(
        fake.dev_users().len(),
        1,
        "the refused start did not connect"
    );
}

// ----- chat_emit（契約 §8.6） ------------------------------------------------------------------

fn emit(hub: &ChatHub, event: Value) -> Result<(), super::ChatCommandError> {
    let event = serde_json::from_value(event).expect("test event must be a valid ClientEvent");
    async_runtime::block_on(hub.emit(event))
}

fn emit_error_code(hub: &ChatHub, event: Value) -> &'static str {
    async_runtime::block_on(hub.emit_json(event))
        .unwrap_err()
        .code
}

#[test]
fn each_chat_event_is_written_as_its_wire_json_in_order() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    let events = vec![
        serde_json::json!({"type": "message.edit", "message_id": "m1", "body": "直した"}),
        serde_json::json!({"type": "message.delete", "message_id": "m2"}),
        serde_json::json!({"type": "reaction.add", "message_id": "m3", "emoji": "👍"}),
        serde_json::json!({"type": "reaction.remove", "message_id": "m3", "emoji": "👍"}),
        serde_json::json!({"type": "call.leave"}),
    ];
    for event in &events {
        emit(&hub, event.clone()).unwrap();
    }
    wait_until("five frames", || fake.frames().len() == events.len());
    assert_eq!(fake.frames(), events);
    // 送るのは書込だけ。message.send としては扱われない
    assert!(fake.sends().is_empty());

    async_runtime::block_on(hub.stop());
}

#[test]
fn message_send_is_refused_and_nothing_is_written() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    let send = serde_json::json!({
        "type": "message.send",
        "client_id": "c-1",
        "body": "hi",
        "attachment_ids": [],
        "reply_to": null,
        "silent": false
    });
    assert_eq!(emit_error_code(&hub, send), "send_not_allowed");
    // 反映されるまで待つ代わりに、ほかのイベントを後に送って順序を確かめる
    emit(
        &hub,
        serde_json::json!({"type": "reaction.add", "message_id": "m1", "emoji": "x"}),
    )
    .unwrap();
    wait_until("the later event", || fake.frames().len() == 1);
    assert_eq!(fake.frames()[0]["type"], "reaction.add");
    assert!(fake.sends().is_empty());

    async_runtime::block_on(hub.stop());
}

#[test]
fn other_kinds_and_malformed_events_are_refused_and_not_written() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // ping は core が扱う（送らない）。call.emit の上限超えも書かない（下のテスト）
    assert_eq!(
        emit_error_code(&hub, serde_json::json!({"type": "ping"})),
        "invalid_request"
    );
    // 形が違う（必須の ID が無い・種類が無い）
    assert_eq!(
        emit_error_code(
            &hub,
            serde_json::json!({"type": "message.edit", "body": "x"})
        ),
        "invalid_request"
    );
    assert_eq!(
        emit_error_code(&hub, serde_json::json!({"message_id": "m1"})),
        "invalid_request"
    );
    // 書込まれたものは 1 つも無い
    emit(
        &hub,
        serde_json::json!({"type": "message.delete", "message_id": "m9"}),
    )
    .unwrap();
    wait_until("the one valid event", || fake.frames().len() == 1);
    assert_eq!(
        fake.frames()[0],
        serde_json::json!({"type": "message.delete", "message_id": "m9"})
    );

    async_runtime::block_on(hub.stop());
}

#[test]
fn emit_without_a_session_is_not_connected_and_writes_nothing() {
    let hub = ChatHub::default();
    let event = serde_json::json!({"type": "reaction.add", "message_id": "m1", "emoji": "👍"});
    assert_eq!(emit_error_code(&hub, event), "not_connected");
}

#[test]
fn emit_after_stop_is_not_connected() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);
    async_runtime::block_on(hub.stop());
    let event = serde_json::json!({"type": "message.delete", "message_id": "m1"});
    assert_eq!(emit_error_code(&hub, event), "not_connected");
    assert!(fake.frames().is_empty());
}

#[test]
fn chat_command_error_serializes_as_code_and_message_only() {
    let json = serde_json::to_value(super::ChatCommandError::from(
        disnans_client_core::EmitError::WriteFailed,
    ))
    .unwrap();
    assert_eq!(json["code"], "write_failed");
    assert!(json.get("status").is_none());
    let codes: Vec<&str> = [
        disnans_client_core::EmitError::NotConnected,
        disnans_client_core::EmitError::WriteFailed,
        disnans_client_core::EmitError::SendNotAllowed,
    ]
    .into_iter()
    .map(|e| super::ChatCommandError::from(e).code)
    .collect();
    assert_eq!(codes, ["not_connected", "write_failed", "send_not_allowed"]);
}

#[test]
fn signaling_session_and_plugin_events_are_written_as_their_wire_json() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    let events = vec![
        serde_json::json!({"type": "call.join", "peer": "p1", "status": {"muted": false, "deafened": false, "device": "laptop"}}),
        serde_json::json!({"type": "call.update", "status": {"muted": true, "deafened": false, "device": null}}),
        serde_json::json!({"type": "call.kick", "peer": "p2"}),
        serde_json::json!({"type": "call.leave"}),
        serde_json::json!({"type": "session.emit", "session_id": "s1", "name": "roll", "payload": {"n": 3}}),
        serde_json::json!({"type": "plugin.emit", "plugin": "dice", "name": "tick", "payload": null}),
    ];
    for event in &events {
        emit(&hub, event.clone()).unwrap();
    }
    wait_until("six frames", || fake.frames().len() == events.len());
    assert_eq!(fake.frames(), events);
    assert!(fake.sends().is_empty());

    async_runtime::block_on(hub.stop());
}

#[test]
fn call_audio_is_written_in_order_with_its_seq_and_pcm() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // 音声フレーム（800 サンプル = 1600 バイトの PCM を base64 にしたもの）を順に 200 件
    let pcm = "A".repeat(2136);
    let mut expected = Vec::new();
    emit(&hub, serde_json::json!({"type": "call.join", "peer": "p1", "status": {"muted": false, "deafened": false}})).unwrap();
    expected.push(serde_json::json!({"type": "call.join", "peer": "p1", "status": {"muted": false, "deafened": false, "device": null}}));
    for seq in 0..200u64 {
        let event = serde_json::json!({"type": "call.emit", "name": "audio", "payload": {"seq": seq, "pcm": pcm}});
        emit(&hub, event.clone()).unwrap();
        expected.push(event);
    }
    emit(&hub, serde_json::json!({"type": "call.leave"})).unwrap();
    expected.push(serde_json::json!({"type": "call.leave"}));

    wait_until("all frames", || fake.frames().len() == expected.len());
    assert_eq!(fake.frames(), expected);
    assert!(fake.sends().is_empty());

    async_runtime::block_on(hub.stop());
}

#[test]
fn call_payload_at_the_server_limit_is_written_and_one_byte_more_is_refused() {
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // payload の JSON（{"pcm":"…"}）がちょうど上限になる長さ
    let overhead = serde_json::to_string(&serde_json::json!({"pcm": ""}))
        .unwrap()
        .len();
    let exact = "A".repeat(MAX_CALL_PAYLOAD_BYTES - overhead);
    let at_limit =
        serde_json::json!({"type": "call.emit", "name": "blob", "payload": {"pcm": exact}});
    emit(&hub, at_limit.clone()).unwrap();
    wait_until("the limit frame", || fake.frames().len() == 1);
    assert_eq!(fake.frames()[0], at_limit);

    let over = "A".repeat(MAX_CALL_PAYLOAD_BYTES - overhead + 1);
    assert_eq!(
        emit_error_code(
            &hub,
            serde_json::json!({"type": "call.emit", "name": "blob", "payload": {"pcm": over}})
        ),
        "invalid_request"
    );
    // 上限超えは書かれていない（次の書込が最初の後続フレーム）
    emit(&hub, serde_json::json!({"type": "call.leave"})).unwrap();
    wait_until("the leave", || fake.frames().len() == 2);
    assert_eq!(fake.frames()[1], serde_json::json!({"type": "call.leave"}));

    async_runtime::block_on(hub.stop());
}

#[test]
fn signaling_without_a_session_is_not_connected() {
    let hub = ChatHub::default();
    assert_eq!(
        emit_error_code(
            &hub,
            serde_json::json!({"type": "call.join", "peer": "p", "status": {"muted": false, "deafened": false}})
        ),
        "not_connected"
    );
    assert_eq!(
        emit_error_code(
            &hub,
            serde_json::json!({"type": "plugin.emit", "plugin": "p", "name": "n", "payload": null})
        ),
        "not_connected"
    );
}

/// 通話の音声の受信（相手 5 人 × 25 件/秒 = 125 件/秒）を 2 秒流しても、取りこぼし（lagged）が出ないこと。
/// 受け手は速い（Collect に入れるだけ）。webview の遅さは含まない（実機で別途確認する）。
#[test]
fn inbound_call_audio_at_the_expected_rate_is_delivered_without_a_lagged_gap() {
    let frames = 250u64; // 125 件/秒 × 2 秒
    let reply: Reply = Arc::new(move |_: usize, value: &Value| {
        let pcm = "A".repeat(2136);
        let mut steps = Vec::new();
        for seq in 0..frames {
            steps.push(Step::Event(ServerEvent::CallEvent {
                peer: "p1".into(),
                from: "u-speaker".into(),
                name: "audio".into(),
                payload: serde_json::json!({"seq": seq, "pcm": pcm}),
            }));
            steps.push(Step::Wait(Duration::from_millis(8)));
        }
        // 最後に ack を返して、送った側（trigger）を終わらせる
        steps.push(ack(value));
        steps
    });
    let fake = Fake::start(reply);
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // 受け取りのきっかけ（この送信にだけ、上の動作が返る）
    async_runtime::block_on(hub.send(draft("trigger", "x"))).unwrap();
    wait_until("all audio", || {
        sink.items()
            .iter()
            .filter(|i| {
                matches!(
                    i,
                    ChatItem::Event {
                        event: ServerEvent::CallEvent { .. },
                        ..
                    }
                )
            })
            .count()
            == frames as usize
    });
    let items = sink.items();
    assert!(
        !items
            .iter()
            .any(|i| matches!(i, ChatItem::Gap { reason, .. } if reason == "lagged")),
        "a lagged gap means audio was dropped"
    );

    async_runtime::block_on(hub.stop());
}

#[test]
fn audio_slots_are_capped_and_returned_when_dropped() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let counter = Arc::new(AtomicUsize::new(0));
    let held: Vec<_> = (0..MAX_AUDIO_IN_FLIGHT)
        .map(|_| take_audio_slot(&counter).expect("under the cap"))
        .collect();
    assert_eq!(counter.load(Ordering::SeqCst), MAX_AUDIO_IN_FLIGHT);
    assert!(take_audio_slot(&counter).is_none(), "over the cap");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        MAX_AUDIO_IN_FLIGHT,
        "a refused slot is not kept"
    );
    drop(held);
    assert_eq!(counter.load(Ordering::SeqCst), 0);
    assert!(take_audio_slot(&counter).is_some());
}

#[test]
fn audio_over_the_in_flight_cap_is_busy_and_not_written_but_control_is_not_capped() {
    use std::sync::atomic::Ordering;
    let fake = Fake::start(echo_everything());
    let hub = ChatHub::default();
    let sink = Collect::new();
    start(&hub, &fake.url, Some("alice"), sink.clone()).unwrap();
    wait_until("connected", || sink.len() >= 1);

    // 書込み待ちが上限に達している状況（書込みが止まったと同じ）を作る
    hub.audio_in_flight
        .store(MAX_AUDIO_IN_FLIGHT, Ordering::SeqCst);
    let audio = serde_json::json!({"type": "call.emit", "name": "audio", "payload": {"seq": 1, "pcm": "AAAA"}});
    assert_eq!(emit_error_code(&hub, audio), "busy");
    // 制御（leave）は枠に関係なく書く
    emit(&hub, serde_json::json!({"type": "call.leave"})).unwrap();
    wait_until("the leave", || fake.frames().len() == 1);
    assert_eq!(fake.frames()[0], serde_json::json!({"type": "call.leave"}));

    // 枠が空けば音声は書ける
    hub.audio_in_flight.store(0, Ordering::SeqCst);
    emit(&hub, serde_json::json!({"type": "call.emit", "name": "audio", "payload": {"seq": 2, "pcm": "AAAA"}})).unwrap();
    wait_until("the audio", || fake.frames().len() == 2);
    assert_eq!(fake.frames()[1]["payload"]["seq"], 2);
    assert_eq!(
        hub.audio_in_flight.load(Ordering::SeqCst),
        0,
        "the slot is returned after the write"
    );

    async_runtime::block_on(hub.stop());
}
